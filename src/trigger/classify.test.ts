/**
 * Classification is pure over the payload, so these run over **recorded
 * payloads** rather than over objects shaped the way the code happens to read
 * them. The fixtures in `./fixtures` follow GitHub's documented payload shapes
 * for `issues` and `workflow_run`, trimmed to the halves this function reads;
 * the identifiers and shas in them are synthetic, so treat them as a model of
 * what GitHub sends rather than as proof of it — a field added or renamed
 * upstream will not show up here. Nothing is mocked, and nothing can be —
 * there is no IO to mock.
 */

import { REQUIRED_LABELS } from '../issue-state/vocabulary'
import { classifyTrigger, PHASE_LABELS, PHASES } from './classify'
import issuesLabeled from './fixtures/issues-labeled.json'
import issuesLabeledInProgress from './fixtures/issues-labeled-in-progress.json'
import issuesOpened from './fixtures/issues-opened.json'
import workflowRunFailed from './fixtures/workflow-run-failed.json'
import workflowRunFailedHumanBranch from './fixtures/workflow-run-failed-human-branch.json'
import workflowRunSucceeded from './fixtures/workflow-run-succeeded.json'

describe('the phase labels', () => {
  it.each(PHASES)(
    'names %s with a label the vocabulary actually carries',
    (phase) => {
      // The binding shopfloor#45 exists to stop rotting: a phase label nothing
      // creates and nothing verifies would classify runs onto a label that does
      // not exist in any repository.
      expect(REQUIRED_LABELS).toContain(PHASE_LABELS[phase])
    }
  )
})

describe('classifyTrigger — the human edge', () => {
  it('classifies ready-for-agent on an issue', () => {
    expect(classifyTrigger(issuesLabeled)).toEqual({
      triggered: true,
      phase: 'implement',
      edge: 'human',
      issueNumber: 46,
      actor: 'galosandoval',
      repo: 'galosandoval/shopfloor'
    })
  })

  it("refuses the harness's own agent:in-progress add, which fires the same event", () => {
    const verdict = classifyTrigger(issuesLabeledInProgress)

    expect(verdict.triggered).toBe(false)
    expect(verdict).toMatchObject({
      reason: expect.stringContaining('agent:in-progress')
    })
  })

  it('is not a trigger when the issue was merely opened', () => {
    expect(classifyTrigger(issuesOpened).triggered).toBe(false)
  })

  it('falls back to the only phase that ships when no phase label is present', () => {
    const payload = withIssueLabels(issuesLabeled, [
      { name: 'ready-for-agent' }
    ])

    expect(classifyTrigger(payload)).toMatchObject({
      triggered: true,
      phase: 'implement'
    })
  })

  it('reads the phase off the issue label when one is present', () => {
    const payload = withIssueLabels(issuesLabeled, [
      { name: 'ready-for-agent' },
      { name: 'agent:implement' }
    ])

    expect(classifyTrigger(payload)).toMatchObject({ phase: 'implement' })
  })

  it('accepts an issue number sent as a string, which a replayed payload does', () => {
    const payload = {
      ...issuesLabeled,
      issue: { ...issuesLabeled.issue, number: '46' }
    }

    expect(classifyTrigger(payload)).toMatchObject({ issueNumber: 46 })
  })
})

describe('classifyTrigger — the machine edge', () => {
  it('classifies a failed CI run on a branch the harness owns', () => {
    expect(classifyTrigger(workflowRunFailed)).toEqual({
      triggered: true,
      phase: 'implement',
      edge: 'machine',
      issueNumber: 46,
      actor: 'galosandoval',
      repo: 'galosandoval/shopfloor'
    })
  })

  it('prefers triggering_actor, whose spend the run continues', () => {
    const payload = {
      ...workflowRunFailed,
      workflow_run: {
        ...workflowRunFailed.workflow_run,
        actor: { login: 'someone-else' },
        triggering_actor: { login: 'galosandoval' }
      }
    }

    expect(classifyTrigger(payload)).toMatchObject({ actor: 'galosandoval' })
  })

  it('falls back to actor when the payload carries no triggering_actor', () => {
    const run = { ...workflowRunFailed.workflow_run, triggering_actor: null }
    const payload = { ...workflowRunFailed, workflow_run: run }

    expect(classifyTrigger(payload)).toMatchObject({ actor: 'galosandoval' })
  })

  it('is not a trigger when CI went green', () => {
    expect(classifyTrigger(workflowRunSucceeded).triggered).toBe(false)
  })

  it('is not a trigger on a branch the harness does not own', () => {
    const verdict = classifyTrigger(workflowRunFailedHumanBranch)

    expect(verdict.triggered).toBe(false)
    expect(verdict).toMatchObject({
      reason: expect.stringContaining('development')
    })
  })
})

describe('classifyTrigger — payloads it must not throw on', () => {
  it.each([
    ['undefined', undefined],
    ['null', null],
    ['a string', 'not a payload'],
    ['an array', []],
    ['an empty object', {}],
    ['an event with no action', { issue: { number: 46 } }],
    [
      'a labeled event with no issue',
      { action: 'labeled', label: { name: 'ready-for-agent' } }
    ],
    ['a completed event with no workflow_run', { action: 'completed' }],
    [
      'a labeled event naming no repository',
      {
        action: 'labeled',
        label: { name: 'ready-for-agent' },
        issue: { number: 46 },
        sender: { login: 'galosandoval' }
      }
    ]
  ])('classifies %s as not a trigger', (_name, payload) => {
    const verdict = classifyTrigger(payload)

    expect(verdict.triggered).toBe(false)
    expect(verdict).toMatchObject({ reason: expect.any(String) })
  })
})

function withIssueLabels(
  payload: typeof issuesLabeled,
  labels: { name: string }[]
) {
  return { ...payload, issue: { ...payload.issue, labels } }
}
