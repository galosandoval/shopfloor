/**
 * Wiring for the terminal state: what crosses the process boundary when a
 * ceiling is spent, and — as load-bearing as anything it does write — what it
 * does not. The decision itself is `exhaustion.test.ts`, with nothing mocked.
 */

import {
  calls,
  execStubModule,
  resetExecStub,
  routeExecStub
} from '../process/exec-stub.test-helper'
import { REQUIRED_LABELS } from '../issue-state/vocabulary'
import type { SpentCeiling } from '../trigger/admission'
import { reportExhaustion } from './run-exhaustion'

vi.mock('node:child_process', () => execStubModule())

const ceiling: SpentCeiling = {
  issueNumber: 50,
  repo: 'acme/widgets',
  branch: 'agent/issue-50',
  attempts: 3,
  maxAttempts: 3,
  currentLabels: ['agent:blocked', 'ready-for-human']
}

const encode = (text: string) => Buffer.from(text, 'utf8').toString('base64')

/** The `[file, ...args]` lines, joined, so a test can match a whole command. */
const commands = () => calls.map((call) => call.join(' '))

const commentBody = () => {
  const comment = calls.find((call) => call.includes('comment'))
  return comment?.[comment.length - 1] ?? ''
}

beforeEach(() => {
  resetExecStub({ stdout: '' })
  routeExecStub([
    {
      match: /contents\/\.agent\/attempts\?/,
      response: {
        stdout: '.agent/attempts/901.md\n.agent/attempts/902.md\n'
      }
    },
    {
      match: /contents\/\.agent\/attempts\/901\.md/,
      response: { stdout: `${encode('# Attempt 1 of 3\n\nfirst')}\n` }
    },
    {
      match: /contents\/\.agent\/attempts\/902\.md/,
      response: { stdout: `${encode('# Attempt 2 of 3\n\nsecond')}\n` }
    },
    {
      match: /gh label list/,
      response: { stdout: `${REQUIRED_LABELS.join('\n')}\n` }
    }
  ])
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('reportExhaustion', () => {
  it('posts the trail it read off the branch and applies the terminal label', async () => {
    const result = await reportExhaustion({ ceiling, cwd: '/repo' })

    expect(result).toMatchObject({
      reported: true,
      transitioned: true,
      attemptsRead: 2
    })
    expect(commentBody()).toContain('first')
    expect(commentBody()).toContain('second')
    expect(commands().join('\n')).toContain('agent:exhausted')
  })

  it('reads the trail at the branch the attempts ran on', async () => {
    await reportExhaustion({ ceiling, cwd: '/repo' })

    expect(commands()).toContainEqual(
      expect.stringContaining(`?ref=${ceiling.branch}`)
    )
  })

  it('reads the trail where the caller says it is, stated or from the env', async () => {
    await reportExhaustion({
      ceiling,
      attemptsDir: '.harness/attempts',
      env: { ATTEMPTS_DIR: '.from-env' },
      cwd: '/repo'
    })

    expect(commands()).toContainEqual(
      expect.stringContaining('contents/.harness/attempts')
    )

    resetExecStub({ stdout: '' })
    await reportExhaustion({ ceiling, env: { ATTEMPTS_DIR: '.from-env' } })

    expect(commands()).toContainEqual(
      expect.stringContaining('contents/.from-env')
    )
  })

  it('comments before it transitions, so the account survives a failed label', async () => {
    await reportExhaustion({ ceiling, cwd: '/repo' })

    const commented = commands().findIndex((command) =>
      command.includes('issue comment')
    )
    const labelled = commands().findIndex((command) =>
      command.includes('agent:exhausted')
    )

    expect(commented).toBeGreaterThanOrEqual(0)
    expect(commented).toBeLessThan(labelled)
  })

  it('closes nothing and strips nothing', async () => {
    // Design §4: the PR stays open, because closing it discards partial work —
    // and the trail is the evidence the comment is made of.
    await reportExhaustion({ ceiling, cwd: '/repo' })

    expect(commands().some((command) => command.includes('pr close'))).toBe(
      false
    )
    expect(commands().some((command) => command.startsWith('git'))).toBe(false)
  })

  it('writes nothing at all when the ceiling was already reported', async () => {
    const result = await reportExhaustion({
      ceiling: { ...ceiling, currentLabels: ['agent:exhausted'] },
      cwd: '/repo'
    })

    expect(result).toMatchObject({ reported: false, transitioned: false })
    expect(commands().some((command) => command.includes('comment'))).toBe(
      false
    )
    expect(commands().some((command) => command.includes('label edit'))).toBe(
      false
    )
  })

  it('reports a branch that never carried a trail as empty, not as evidence lost', async () => {
    // A 404 is what an absent directory *and* an empty one both look like
    // here, so it is the ordinary first-attempt-exhausted case rather than a
    // fault. Claiming part of the trail could not be read would put a lost
    // evidence warning on the most-read comment the loop writes.
    routeExecStub([
      {
        match: /contents/,
        response: { fails: 1, stderr: 'gh: Not Found (HTTP 404)' }
      },
      {
        match: /gh label list/,
        response: { stdout: `${REQUIRED_LABELS.join('\n')}\n` }
      }
    ])

    const result = await reportExhaustion({ ceiling, cwd: '/repo' })

    expect(result).toMatchObject({ reported: true, attemptsRead: 0 })
    expect(result.detail).toBeUndefined()
    expect(commentBody()).toContain('No handoff documents were found')
    expect(commentBody()).not.toContain('could not be read')
  })

  it('still reports when the trail cannot be read for a real reason, saying so', async () => {
    routeExecStub([
      {
        match: /contents/,
        response: { fails: 1, stderr: 'gh: Bad credentials (HTTP 401)' }
      },
      {
        match: /gh label list/,
        response: { stdout: `${REQUIRED_LABELS.join('\n')}\n` }
      }
    ])

    const result = await reportExhaustion({ ceiling, cwd: '/repo' })

    // The ceiling is a fact whether or not the evidence for it survived, and
    // an issue left unlabelled because a fetch failed is an issue the loop
    // silently abandoned.
    expect(result).toMatchObject({ reported: true, attemptsRead: 0 })
    expect(commentBody()).toContain('could not be read')
    expect(commentBody()).toContain('401')
  })

  it('writes nothing when the repository cannot carry the terminal label', async () => {
    // Reporting once is enforced by the label being there next time, so a
    // comment posted without one is posted again on every later event — a
    // comment generator, reached by the one failure that is knowable up front.
    routeExecStub([
      { match: /contents/, response: { stdout: '' } },
      { match: /gh label list/, response: { stdout: '' } }
    ])

    const result = await reportExhaustion({ ceiling, cwd: '/repo' })

    expect(result).toMatchObject({ reported: false, transitioned: false })
    expect(result.detail).toContain('agent:exhausted')
    expect(commands().some((command) => command.includes('comment'))).toBe(
      false
    )
  })
})
