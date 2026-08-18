import type { AuthorizationVerdict } from '../guardrails/authorization'
import { IN_PROGRESS_LABEL } from '../issue-state/vocabulary'
import {
  DEFAULT_MAX_ATTEMPTS,
  evaluateAdmission,
  type AdmissionInput
} from './admission'
import type { TriggerClassification } from './classify'

const triggered: TriggerClassification = {
  triggered: true,
  phase: 'implement',
  edge: 'human',
  issueNumber: 46,
  actor: 'galosandoval',
  repo: 'galosandoval/shopfloor'
}

const authorized: AuthorizationVerdict = {
  authorized: true,
  permission: 'admin'
}

function admission(overrides: Partial<AdmissionInput> = {}) {
  return evaluateAdmission({
    classification: triggered,
    authorization: authorized,
    history: history(),
    ...overrides
  })
}

/**
 * A read of the issue: every label ever added to it, and what is on it now.
 * Defaults to a fresh issue nobody has run.
 */
function history(labelAdditions: string[] = [], currentLabels: string[] = []) {
  return { answered: true, labelAdditions, currentLabels } as const
}

/** The trace one started run leaves in the timeline. */
const ONE_ATTEMPT = [IN_PROGRESS_LABEL]

describe('evaluateAdmission', () => {
  it('admits a classified, authorized event on an issue nobody has run', () => {
    expect(admission()).toEqual({
      admitted: true,
      phase: 'implement',
      edge: 'human',
      issueNumber: 46,
      actor: 'galosandoval',
      repo: 'galosandoval/shopfloor',
      branch: 'agent/issue-46',
      attempt: 1,
      maxAttempts: DEFAULT_MAX_ATTEMPTS,
      permission: 'admin'
    })
  })

  it('counts the attempt this run would be', () => {
    const twice = [...ONE_ATTEMPT, ...ONE_ATTEMPT]

    expect(admission({ history: history(twice) })).toMatchObject({
      admitted: true,
      attempt: 3
    })
  })

  it('counts only the in-progress label, not every label ever added', () => {
    const noise = [
      'ready-for-agent',
      'bug',
      'agent:implement',
      'ready-for-human'
    ]

    expect(admission({ history: history(noise) })).toMatchObject({
      admitted: true,
      attempt: 1
    })
  })

  it('carries the classification through rather than restating it', () => {
    const verdict = admission({
      classification: { ...triggered, edge: 'machine', issueNumber: 7 }
    })

    expect(verdict).toMatchObject({
      admitted: true,
      edge: 'machine',
      issueNumber: 7,
      branch: 'agent/issue-7'
    })
  })
})

describe('evaluateAdmission — refusals', () => {
  it('refuses an event that classified as nothing, with that reason', () => {
    const verdict = admission({
      classification: { triggered: false, reason: 'the label added was "bug"' }
    })

    expect(verdict).toEqual({
      admitted: false,
      refusal: 'not-a-trigger',
      reason: 'the label added was "bug"'
    })
  })

  it('refuses an actor the spend gate turned down, keeping its refusal kind', () => {
    const verdict = admission({
      authorization: {
        authorized: false,
        refusal: 'not-permitted',
        reason: '@drive-by has "triage" permission'
      }
    })

    expect(verdict).toEqual({
      admitted: false,
      refusal: 'not-permitted',
      reason: '@drive-by has "triage" permission'
    })
  })

  it('refuses when the spend gate could not determine an answer', () => {
    const verdict = admission({
      authorization: {
        authorized: false,
        refusal: 'undetermined',
        reason: 'the permission probe failed'
      }
    })

    expect(verdict).toMatchObject({ admitted: false, refusal: 'undetermined' })
  })

  it('refuses when the spend gate was never run at all', () => {
    expect(admission({ authorization: undefined })).toMatchObject({
      admitted: false,
      refusal: 'undetermined',
      reason: expect.stringContaining('never run')
    })
  })

  it('refuses on an unreadable issue rather than reading it as untouched', () => {
    const verdict = admission({
      history: { answered: false, detail: 'gh: Bad credentials (HTTP 401)' }
    })

    expect(verdict).toMatchObject({
      admitted: false,
      refusal: 'undetermined',
      reason: expect.stringContaining('gh: Bad credentials (HTTP 401)')
    })
  })

  it('refuses when the issue was never read at all', () => {
    expect(admission({ history: undefined })).toMatchObject({
      admitted: false,
      refusal: 'undetermined',
      reason: expect.stringContaining('#46')
    })
  })

  it('refuses while the issue is labeled in-progress', () => {
    const verdict = admission({
      history: history(ONE_ATTEMPT, [IN_PROGRESS_LABEL, 'ready-for-agent'])
    })

    expect(verdict).toMatchObject({
      admitted: false,
      refusal: 'in-flight',
      reason: expect.stringContaining(IN_PROGRESS_LABEL)
    })
  })

  it('refuses once the ceiling is spent', () => {
    const spent = [...ONE_ATTEMPT, ...ONE_ATTEMPT, ...ONE_ATTEMPT]

    expect(admission({ history: history(spent) })).toMatchObject({
      admitted: false,
      refusal: 'exhausted',
      reason: expect.stringContaining('#46')
    })
  })

  it('honours a stated ceiling over the default', () => {
    const verdict = admission({
      history: history(ONE_ATTEMPT),
      maxAttempts: 1
    })

    expect(verdict).toMatchObject({ admitted: false, refusal: 'exhausted' })
  })

  it('refuses in-flight before exhausted — the run to wait for is the news', () => {
    const verdict = admission({
      history: history(
        [...ONE_ATTEMPT, ...ONE_ATTEMPT, ...ONE_ATTEMPT],
        [IN_PROGRESS_LABEL]
      )
    })

    expect(verdict).toMatchObject({ refusal: 'in-flight' })
  })

  it('refuses the classification before it judges the actor', () => {
    const verdict = evaluateAdmission({
      classification: { triggered: false, reason: 'not ours' },
      authorization: {
        authorized: false,
        refusal: 'not-permitted',
        reason: 'a stranger'
      },
      history: { answered: false, detail: 'gh exploded' }
    })

    expect(verdict).toMatchObject({ refusal: 'not-a-trigger' })
  })
})

describe('evaluateAdmission — what the count survives', () => {
  it('counts a run whose label was cleared, which is what the timeline is for', () => {
    // Every terminal transition removes `agent:in-progress`, so the label is
    // gone and only the timeline remembers the run happened. A count read off
    // the current labels would report zero attempts forever.
    const verdict = admission({
      history: history([...ONE_ATTEMPT, ...ONE_ATTEMPT], ['ready-for-human'])
    })

    expect(verdict).toMatchObject({ admitted: true, attempt: 3 })
  })

  it('counts a run killed before it could clean up', () => {
    // A wall-clock kill leaves the label on the issue and its addition in the
    // timeline — the run the file-counting rejected in design §4 would miss.
    const verdict = admission({
      history: history(ONE_ATTEMPT, [IN_PROGRESS_LABEL])
    })

    expect(verdict).toMatchObject({ refusal: 'in-flight' })
  })
})
