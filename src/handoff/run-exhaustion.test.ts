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

  it('still reports when the trail cannot be read, saying so', async () => {
    routeExecStub([
      { match: /contents/, response: { fails: 1, stderr: 'Not Found' } },
      {
        match: /gh label list/,
        response: { stdout: `${REQUIRED_LABELS.join('\n')}\n` }
      }
    ])

    const result = await reportExhaustion({ ceiling, cwd: '/repo' })

    // The ceiling is a fact whether or not the evidence for it survived, and
    // an issue left unlabelled because a fetch 404'd is an issue the loop
    // silently abandoned.
    expect(result).toMatchObject({ reported: true, attemptsRead: 0 })
    expect(commentBody()).toContain('No handoff documents were found')
  })

  it('reports a repository missing the vocabulary rather than throwing at it', async () => {
    routeExecStub([
      { match: /contents/, response: { stdout: '' } },
      { match: /gh label list/, response: { stdout: '' } }
    ])

    const result = await reportExhaustion({ ceiling, cwd: '/repo' })

    expect(result).toMatchObject({ reported: true, transitioned: false })
    expect(result.detail).toContain('agent:exhausted')
  })
})
