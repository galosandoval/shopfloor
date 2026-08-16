/**
 * Wiring for the preflight shell — specifically that its refusal now goes
 * through the issue-state transition table rather than the two label literals
 * it used to carry (shopfloor#45), and that the labels it transitions from are
 * read rather than assumed. The refusal logic itself is tested pure in
 * `preflight.test.ts`.
 */

import { REQUIRED_LABELS } from '../issue-state/vocabulary'
import {
  calls,
  execStubModule,
  resetExecStub,
  routeExecStub
} from '../process/exec-stub.test-helper'
import { runPreflight } from './run-preflight'

vi.mock('node:child_process', () => execStubModule())

/**
 * A leaf issue with no open PR — the shape preflight admits — in a repository
 * carrying the whole vocabulary, which is what the shell now checks first.
 * `repoLabels` narrows that to test the refusal.
 */
function stubIssue(
  overrides: {
    subIssues?: number
    parent?: number | null
    labels?: string[]
    repoLabels?: string[] | 'unreadable'
  } = {}
): void {
  resetExecStub({ stdout: '' })
  routeExecStub([
    {
      match: /label list/,
      response:
        overrides.repoLabels === 'unreadable'
          ? { fails: 1 }
          : {
              stdout: (overrides.repoLabels ?? REQUIRED_LABELS).join('\n')
            }
    },
    {
      match: /issue view/,
      response: {
        stdout: JSON.stringify({
          parent:
            overrides.parent === undefined || overrides.parent === null
              ? null
              : { number: overrides.parent },
          subIssues: { totalCount: overrides.subIssues ?? 0 },
          labels: (
            overrides.labels ?? ['ready-for-agent', 'agent:implement']
          ).map((name) => ({ name }))
        })
      }
    },
    { match: /pr list/, response: { stdout: '[]' } }
  ])
}

const editCall = () =>
  calls.find((call) => call[1] === 'issue' && call[2] === 'edit')

const viewCall = () =>
  calls.find((call) => call[1] === 'issue' && call[2] === 'view')

describe('runPreflight', () => {
  it('reads the issue’s labels on the call it already makes', async () => {
    stubIssue()

    await runPreflight({ issueNumber: '45', repo: 'acme/widgets' })

    expect(viewCall()).toContain('parent,subIssues,labels')
  })

  it('verifies the label vocabulary before it does anything else', async () => {
    stubIssue()

    await runPreflight({ issueNumber: '45', repo: 'acme/widgets' })

    // First act, not merely somewhere: the point is that nothing this shell
    // does — least of all the transition — runs against a repository whose
    // vocabulary was never checked.
    expect(calls[0]).toEqual(
      expect.arrayContaining(['gh', 'label', 'list', '--repo', 'acme/widgets'])
    )
  })

  it('refuses, naming the missing labels, and writes nothing', async () => {
    stubIssue({ subIssues: 3, repoLabels: ['ready-for-agent'] })

    await expect(
      runPreflight({ issueNumber: '45', repo: 'acme/widgets' })
    ).rejects.toThrow(/ready-for-human/)

    // The refusal would otherwise have transitioned the issue onto labels the
    // repository does not have — the failure shopfloor#45 exists to prevent.
    expect(editCall()).toBeUndefined()
    expect(viewCall()).toBeUndefined()
  })

  it('refuses when the repository’s labels cannot be read at all', async () => {
    stubIssue({ repoLabels: 'unreadable' })

    await expect(
      runPreflight({ issueNumber: '45', repo: 'acme/widgets' })
    ).rejects.toThrow(/could not be read/)
  })

  it('writes nothing when the issue is admitted', async () => {
    stubIssue()

    const { verdict } = await runPreflight({
      issueNumber: '45',
      repo: 'acme/widgets'
    })

    expect(verdict).toEqual({ refused: false })
    expect(editCall()).toBeUndefined()
  })

  it('applies the table’s refused row, ready-for-human included', async () => {
    stubIssue({ subIssues: 3 })

    const { verdict } = await runPreflight({
      issueNumber: '45',
      repo: 'acme/widgets'
    })

    expect(verdict.refused).toBe(true)
    expect(editCall()).toEqual([
      'gh',
      'issue',
      'edit',
      '45',
      '--repo',
      'acme/widgets',
      '--remove-label',
      'ready-for-agent',
      '--remove-label',
      'agent:implement',
      '--add-label',
      'agent:blocked',
      '--add-label',
      'ready-for-human'
    ])
  })

  it('does not re-add a label the issue already carries', async () => {
    stubIssue({ subIssues: 1, labels: ['agent:implement', 'agent:blocked'] })

    await runPreflight({ issueNumber: '45', repo: 'acme/widgets' })

    expect(editCall()).toEqual([
      'gh',
      'issue',
      'edit',
      '45',
      '--repo',
      'acme/widgets',
      '--remove-label',
      'agent:implement',
      '--add-label',
      'ready-for-human'
    ])
  })

  it('still explains the refusal in a comment', async () => {
    stubIssue({ parent: 7 })

    await runPreflight({ issueNumber: '45', repo: 'acme/widgets' })

    const comment = calls.find((call) => call[2] === 'comment')
    expect(comment?.at(-1)).toContain('sub-issue of #7')
  })

  it('tells the human to re-add the label the loop actually triggers on', async () => {
    stubIssue({ parent: 7 })

    await runPreflight({ issueNumber: '45', repo: 'acme/widgets' })

    const body = calls.find((call) => call[2] === 'comment')?.at(-1) ?? ''
    // `agent:implement` is what the refusal used to name, and re-adding it
    // would never retrigger the workflow: the trigger watches
    // `ready-for-agent`, which this transition drops precisely so re-adding it
    // fires an `issues.labeled` event.
    expect(body).toContain('re-add `ready-for-agent` to retry')
    expect(body).not.toContain('re-add `agent:implement`')
    // And it states the state it left behind, from the transition it applied.
    expect(body).toContain('`agent:blocked` + `ready-for-human`')
  })
})
