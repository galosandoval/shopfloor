import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { runTrajectoryCheck } from './run-trajectory-check'
import type { TranscriptEvent } from './trajectory'

// Wiring tests for the shell: real files in a real tmpdir rather than a mocked
// `fs`, because what is under test is precisely whether it reads a transcript
// off disk and writes a scorecard back. The grading itself is covered by
// `trajectory.test.ts` — here we assert only that the shell reaches it with
// what it read, and that its never-throw contract holds.

let dir: string
let nextTurn = 0

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'trajectory-'))
  nextTurn = 0
})

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true })
})

/** Write `events` as JSONL, plus any raw trailing lines, and return the path. */
function writeTranscript(events: TranscriptEvent[], ...rawLines: string[]) {
  const file = path.join(dir, 'transcript.jsonl')
  const lines = [...events.map((e) => JSON.stringify(e)), ...rawLines]
  fs.writeFileSync(file, `${lines.join('\n')}\n`)
  return file
}

function step(command: string, failed = false): TranscriptEvent[] {
  nextTurn += 1
  const id = `tool_${nextTurn}`
  return [
    {
      type: 'assistant',
      message: {
        id: `msg_${nextTurn}`,
        content: [{ type: 'tool_use', id, name: 'Bash', input: { command } }]
      }
    },
    {
      type: 'user',
      message: {
        content: [{ type: 'tool_result', tool_use_id: id, is_error: failed }]
      }
    }
  ]
}

describe('runTrajectoryCheck', () => {
  it('grades the transcript it read and renders the scorecard', () => {
    const transcriptFile = writeTranscript([
      ...step('npm test', true),
      ...step('npm test'),
      ...step('git commit -m "feat: x"')
    ])

    const result = runTrajectoryCheck({ transcriptFile, maxTurns: 150 })

    expect(result.graded).toBe(true)
    expect(result.findings.map((f) => f.status)).toEqual([
      'pass',
      'pass',
      'pass',
      'pass'
    ])
    expect(result.scorecard).toContain('4/4 process invariants passed')
  })

  it('passes the turn cap through to the budget invariant', () => {
    const transcriptFile = writeTranscript([...step('npm test')])

    const result = runTrajectoryCheck({ transcriptFile, maxTurns: 7 })

    const budget = result.findings.find((f) => f.id === 'turn-budget-headroom')
    expect(budget?.detail).toContain('/7 turns')
  })

  it('passes caller-stated gate patterns through to the gate invariant', () => {
    const transcriptFile = writeTranscript([
      ...step('make check'),
      ...step('git commit -m "feat: x"')
    ])

    const result = runTrajectoryCheck({
      transcriptFile,
      maxTurns: 150,
      gateCommandPatterns: [/\bmake\s+check\b/]
    })

    const gate = result.findings.find((f) => f.id === 'gate-before-commit')
    expect(gate?.status).toBe('pass')
  })

  it('passes the headroom fraction through to the budget invariant', () => {
    const transcriptFile = writeTranscript([...step('npm test')])

    const result = runTrajectoryCheck({
      transcriptFile,
      maxTurns: 10,
      headroomFraction: 0.95
    })

    const budget = result.findings.find((f) => f.id === 'turn-budget-headroom')
    expect(budget?.status).toBe('fail')
  })

  it('writes the scorecard to `scorecardFile` when one is stated', () => {
    const transcriptFile = writeTranscript([...step('npm test')])
    const scorecardFile = path.join(dir, 'trajectory_scorecard.md')

    const result = runTrajectoryCheck({
      transcriptFile,
      maxTurns: 150,
      scorecardFile
    })

    expect(fs.readFileSync(scorecardFile, 'utf8')).toBe(`${result.scorecard}\n`)
  })

  it('writes nothing when no `scorecardFile` is stated', () => {
    const transcriptFile = writeTranscript([...step('npm test')])

    runTrajectoryCheck({ transcriptFile, maxTurns: 150 })

    expect(fs.readdirSync(dir)).toEqual(['transcript.jsonl'])
  })

  it('drops a malformed line rather than failing the read', () => {
    const transcriptFile = writeTranscript(
      [...step('npm test', true), ...step('npm test')],
      '{"type":"assistant","message"' // a transcript cut off mid-write
    )

    const result = runTrajectoryCheck({ transcriptFile, maxTurns: 150 })

    expect(result.graded).toBe(true)
    expect(result.findings).toHaveLength(4)
  })

  it('reports ungraded, not an error, when the transcript is missing', () => {
    const result = runTrajectoryCheck({
      transcriptFile: path.join(dir, 'absent.jsonl'),
      maxTurns: 150
    })

    expect(result.graded).toBe(false)
    expect(result.findings).toEqual([])
    expect(result.scorecard).toBeNull()
  })

  it('reports ungraded, not an error, when the transcript has no turns', () => {
    const transcriptFile = writeTranscript([])

    const result = runTrajectoryCheck({ transcriptFile, maxTurns: 150 })

    expect(result.graded).toBe(true)
    expect(result.findings.every((f) => f.status === 'not-evaluable')).toBe(
      true
    )
  })

  it('never throws when the scorecard cannot be written', () => {
    const transcriptFile = writeTranscript([...step('npm test')])

    const result = runTrajectoryCheck({
      transcriptFile,
      maxTurns: 150,
      // A path under a file, not a directory — the write cannot succeed.
      scorecardFile: path.join(transcriptFile, 'nope.md')
    })

    expect(result.graded).toBe(true)
    expect(result.scorecard).toContain('Trajectory scorecard')
    expect(result.error).toBeDefined()
  })
})
