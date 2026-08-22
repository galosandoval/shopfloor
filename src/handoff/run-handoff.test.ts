/**
 * Wiring for the handoff shell. The document itself is tested pure next door;
 * what is tested here is what crosses the process boundary — that the file is
 * written and committed as the agent, that the CI log fetch degrades instead of
 * throwing, that a killed run still gets a file, and that the strip commits
 * only when there was something to strip.
 */

import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import {
  calls,
  execStubModule,
  resetExecStub,
  routeExecStub
} from '../process/exec-stub.test-helper'
import { AGENT_COMMIT_AUTHOR } from '../trigger/classify'
import { DEFAULT_ATTEMPTS_DIR } from './handoff'
import {
  stripAttempts,
  writeHandoff,
  type WriteHandoffInput
} from './run-handoff'

vi.mock('node:child_process', () => execStubModule())

let cwd: string

const input = (
  overrides: Partial<WriteHandoffInput> = {}
): WriteHandoffInput => ({
  attempt: 2,
  maxAttempts: 3,
  issueNumber: 49,
  repo: 'acme/widgets',
  branch: 'agent/issue-49',
  outcome: 'failed',
  failure: 'Claude CLI exited with status 1.',
  attemptsDir: DEFAULT_ATTEMPTS_DIR,
  cwd,
  env: { GITHUB_RUN_ID: '900', GITHUB_REPOSITORY: 'acme/widgets' },
  ...overrides
})

/** The `[file, ...args]` lines, joined, so a test can match on a whole command. */
const commands = () => calls.map((call) => call.join(' '))

const read = (file: string) => fs.readFileSync(path.join(cwd, file), 'utf8')

beforeEach(() => {
  cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'shopfloor-handoff-'))
  resetExecStub({ stdout: '' })
})

afterEach(() => {
  fs.rmSync(cwd, { recursive: true, force: true })
})

describe('writeHandoff', () => {
  it('writes the attempt file under the attempts directory, named by run id', async () => {
    const result = await writeHandoff(input())

    expect(result.written).toBe(true)
    expect(result.file).toBe('.agent/attempts/900.md')
    expect(read(result.file)).toContain('Attempt 2 of 3')
  })

  it('commits it as the agent, so the machine edge still recognizes the head commit', async () => {
    await writeHandoff(input())

    const commit = commands().find((command) => command.includes(' commit '))
    expect(commit).toContain(`user.name=${AGENT_COMMIT_AUTHOR}`)
    expect(commit).toContain('--no-verify')
    expect(commit).toContain('.agent/attempts/900.md')
  })

  it('folds in what the agent claimed, when it wrote any', async () => {
    const claimsFile = path.join(cwd, 'claims.md')
    fs.writeFileSync(claimsFile, 'I abandoned the cache approach.')

    const result = await writeHandoff(input({ claimsFile }))

    expect(read(result.file)).toContain('I abandoned the cache approach.')
  })

  it('says why the agent half is missing when the run was killed', async () => {
    const result = await writeHandoff(
      input({
        claimsFile: path.join(cwd, 'never-written.md'),
        failure: 'Runaway agent: no output for 15 minutes.'
      })
    )

    expect(result.written).toBe(true)
    // The harness says which file it looked in, and does not guess at *why* it
    // is empty — a kill and an agent that skipped the file look the same here.
    expect(read(result.file)).toContain('never-written.md')
    expect(read(result.file)).toContain('Runaway agent')
  })

  it('fetches the failing logs for the CI run that triggered the attempt', async () => {
    routeExecStub([
      {
        match: /gh run view 4242/,
        response: { stdout: 'FAIL src/thing.test.ts' }
      }
    ])

    const result = await writeHandoff(
      input({
        ciFailure: {
          runId: '4242',
          runUrl: 'https://github.com/acme/widgets/actions/runs/4242'
        }
      })
    )

    expect(commands()).toContainEqual(
      'gh run view 4242 --repo acme/widgets --log-failed'
    )
    expect(read(result.file)).toContain('FAIL src/thing.test.ts')
  })

  it('degrades to URL-only when the log fetch fails, rather than blocking', async () => {
    routeExecStub([{ match: /gh run view/, response: { fails: 1 } }])

    const result = await writeHandoff(
      input({
        ciFailure: {
          runId: '4242',
          runUrl: 'https://github.com/acme/widgets/actions/runs/4242'
        }
      })
    )

    expect(result.written).toBe(true)
    expect(read(result.file)).toContain(
      'https://github.com/acme/widgets/actions/runs/4242'
    )
    expect(read(result.file)).toContain('could not be fetched')
  })

  it('reports a failed commit instead of throwing', async () => {
    routeExecStub([{ match: /commit --no-verify/, response: { fails: 1 } }])

    const result = await writeHandoff(input())

    expect(result.written).toBe(true)
    expect(result.committed).toBe(false)
    expect(result.detail).toBeTruthy()
  })

  it('falls back to the head commit when no CI run names the attempt', async () => {
    routeExecStub([
      { match: /git rev-parse/, response: { stdout: 'abc1234\n' } }
    ])

    const result = await writeHandoff(input({ env: {} }))

    expect(result.file).toBe('.agent/attempts/local-abc1234.md')
  })

  it('keeps a re-run from overwriting the run it re-ran', async () => {
    const result = await writeHandoff(
      input({ env: { GITHUB_RUN_ID: '900', GITHUB_RUN_ATTEMPT: '2' } })
    )

    expect(result.file).toBe('.agent/attempts/900-2.md')
  })
})

describe('stripAttempts', () => {
  it('removes the trail and commits the removal', async () => {
    routeExecStub([
      {
        match: /git ls-files/,
        response: { stdout: '.agent/attempts/1.md\n.agent/attempts/2.md\n' }
      }
    ])

    const result = await stripAttempts({
      attemptsDir: DEFAULT_ATTEMPTS_DIR,
      cwd
    })

    expect(result).toMatchObject({ stripped: true, removed: 2 })
    expect(commands()).toContainEqual('git rm -r --quiet -- .agent/attempts')
    expect(commands().some((command) => command.includes(' commit '))).toBe(
      true
    )
  })

  it('commits nothing when there was no trail', async () => {
    const result = await stripAttempts({
      attemptsDir: DEFAULT_ATTEMPTS_DIR,
      cwd
    })

    expect(result).toMatchObject({ stripped: false, removed: 0 })
    expect(commands().some((command) => command.includes(' commit '))).toBe(
      false
    )
  })
})
