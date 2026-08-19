/**
 * Wiring, not decisions: the verdicts themselves are covered by
 * `admission.test.ts` and `classify.test.ts` with nothing mocked. What is
 * asserted here is that this shell reaches the probes it claims to — and, just
 * as load-bearing, that it **does not** reach the expensive ones once the
 * verdict is settled without them. A spend gate that ran the probes in the
 * wrong order would still return the right verdict.
 */

import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  calls,
  execStubModule,
  resetExecStub,
  routeExecStub
} from '../process/exec-stub.test-helper'
import issuesLabeled from './fixtures/issues-labeled.json'
import workflowRunFailed from './fixtures/workflow-run-failed.json'
import workflowRunFailedFork from './fixtures/workflow-run-failed-fork.json'
import { runAdmission } from './run-admission'

vi.mock('node:child_process', () => execStubModule())

const PERMISSION = /gh api repos\/[^ ]+\/collaborators/
const TIMELINE = /timeline/
const ISSUE_VIEW = /gh issue view/

const env = { GITHUB_WORKFLOW: 'Agent implement' }

/** The trace one started run leaves in an issue's timeline. */
const ONE_ATTEMPT = 'agent:in-progress'

beforeEach(() => {
  resetExecStub()
  routeExecStub([
    { match: PERMISSION, response: { stdout: 'admin\n' } },
    { match: TIMELINE, response: { stdout: 'ready-for-agent\n' } },
    { match: ISSUE_VIEW, response: { stdout: 'ready-for-agent\n' } }
  ])
})

/** Route the two issue reads together — they answer one question each. */
function issueIs(timeline: string[], current: string[]) {
  routeExecStub([
    { match: PERMISSION, response: { stdout: 'admin' } },
    { match: TIMELINE, response: { stdout: timeline.join('\n') } },
    { match: ISSUE_VIEW, response: { stdout: current.join('\n') } }
  ])
}

function readTheIssue() {
  return calls.some((call) => TIMELINE.test(call.join(' ')))
}

describe('runAdmission', () => {
  it('admits a labeled issue nobody is already running', async () => {
    const verdict = await runAdmission({ payload: issuesLabeled, env })

    expect(verdict).toMatchObject({
      admitted: true,
      phase: 'implement',
      issueNumber: 46,
      branch: 'agent/issue-46',
      attempt: 1,
      authorizedBy: { via: 'permission', permission: 'admin' }
    })
  })

  it('admits the machine edge without ever running the spend gate', async () => {
    const verdict = await runAdmission({ payload: workflowRunFailed, env })

    // The probe is not merely ignored — it is never taken. The permission call
    // on this edge would ask what `github-actions[bot]` may do and get `none`,
    // which is how the loop's own retrigger refused every time.
    expect(calls.some((call) => PERMISSION.test(call.join(' ')))).toBe(false)
    expect(verdict).toMatchObject({
      admitted: true,
      edge: 'machine',
      issueNumber: 46,
      authorizedBy: { via: 'continuation' }
    })
  })

  it('refuses a fork branch named like the harness’s, before any probe', async () => {
    const verdict = await runAdmission({ payload: workflowRunFailedFork, env })

    expect(calls).toEqual([])
    expect(verdict).toMatchObject({
      admitted: false,
      refusal: 'not-a-trigger'
    })
  })

  it('reads the label history off the issue the event named', async () => {
    await runAdmission({ payload: issuesLabeled, env })

    const timeline = calls.find((call) => TIMELINE.test(call.join(' ')))

    expect(timeline).toEqual([
      'gh',
      'api',
      'repos/galosandoval/shopfloor/issues/46/timeline',
      '--paginate',
      '--jq',
      '.[] | select(.event == "labeled") | .label.name'
    ])
  })

  it('reads the labels on the issue now, for the concurrency check', async () => {
    await runAdmission({ payload: issuesLabeled, env })

    const view = calls.find((call) => ISSUE_VIEW.test(call.join(' ')))

    expect(view).toEqual([
      'gh',
      'issue',
      'view',
      '46',
      '--repo',
      'galosandoval/shopfloor',
      '--json',
      'labels',
      '--jq',
      '.labels[].name'
    ])
  })

  it('counts a prior attempt whose label the run already cleared', async () => {
    issueIs(['ready-for-agent', ONE_ATTEMPT], ['ready-for-human'])

    expect(await runAdmission({ payload: issuesLabeled, env })).toMatchObject({
      admitted: true,
      attempt: 2
    })
  })

  it('refuses while a run is in flight', async () => {
    issueIs([ONE_ATTEMPT], [ONE_ATTEMPT])

    expect(await runAdmission({ payload: issuesLabeled, env })).toMatchObject({
      admitted: false,
      refusal: 'in-flight'
    })
  })

  it('honours a stated ceiling', async () => {
    issueIs([ONE_ATTEMPT], [])

    const verdict = await runAdmission({
      payload: issuesLabeled,
      env,
      maxAttempts: 1
    })

    expect(verdict).toMatchObject({ admitted: false, refusal: 'exhausted' })
  })
})

describe('runAdmission — what it refuses to pay for', () => {
  it('probes nothing at all for an event that is not a trigger', async () => {
    const verdict = await runAdmission({
      payload: { action: 'opened', issue: { number: 46 } },
      env
    })

    expect(verdict).toMatchObject({ admitted: false, refusal: 'not-a-trigger' })
    expect(calls).toEqual([])
  })

  it('never reads the issue for an actor who may not spend', async () => {
    routeExecStub([{ match: PERMISSION, response: { stdout: 'triage' } }])

    const verdict = await runAdmission({ payload: issuesLabeled, env })

    expect(verdict).toMatchObject({ admitted: false, refusal: 'not-permitted' })
    expect(readTheIssue()).toBe(false)
  })

  it('never reads the issue when the permission probe could not answer', async () => {
    routeExecStub([
      {
        match: PERMISSION,
        response: { fails: 1, stderr: 'gh: Bad credentials' }
      }
    ])

    const verdict = await runAdmission({ payload: issuesLabeled, env })

    expect(verdict).toMatchObject({ admitted: false, refusal: 'undetermined' })
    expect(readTheIssue()).toBe(false)
  })
})

describe('runAdmission — probes that cannot answer', () => {
  it('refuses, naming what gh said, when the timeline read fails', async () => {
    routeExecStub([
      { match: PERMISSION, response: { stdout: 'admin' } },
      {
        match: TIMELINE,
        response: {
          fails: 1,
          stderr: 'gh: Resource not accessible by integration'
        }
      },
      { match: ISSUE_VIEW, response: { stdout: '' } }
    ])

    expect(await runAdmission({ payload: issuesLabeled, env })).toMatchObject({
      admitted: false,
      refusal: 'undetermined',
      reason: expect.stringContaining('Resource not accessible')
    })
  })

  it('refuses when the labels cannot be read, though the timeline could', async () => {
    routeExecStub([
      { match: PERMISSION, response: { stdout: 'admin' } },
      { match: TIMELINE, response: { stdout: 'ready-for-agent' } },
      { match: ISSUE_VIEW, response: { fails: 1, stderr: 'gh: Not Found' } }
    ])

    expect(await runAdmission({ payload: issuesLabeled, env })).toMatchObject({
      admitted: false,
      refusal: 'undetermined'
    })
  })

  it('reads an issue with no labels at all as untouched, not as one blank label', async () => {
    issueIs([], [])

    expect(await runAdmission({ payload: issuesLabeled, env })).toMatchObject({
      admitted: true,
      attempt: 1
    })
  })
})

describe('runAdmission — the payload', () => {
  it('reads GITHUB_EVENT_PATH when the caller states no payload', async () => {
    const eventPath = join(
      await mkdtemp(join(tmpdir(), 'shopfloor-admit-')),
      'event.json'
    )
    await writeFile(eventPath, JSON.stringify(issuesLabeled), 'utf8')

    const verdict = await runAdmission({
      env: { ...env, GITHUB_EVENT_PATH: eventPath }
    })

    expect(verdict).toMatchObject({ admitted: true, issueNumber: 46 })
  })

  it.each([
    ['GITHUB_EVENT_PATH is unset', {}],
    ['the file does not exist', { GITHUB_EVENT_PATH: '/nope/event.json' }]
  ])(
    'refuses rather than reporting "not a trigger" when %s',
    async (_name, extra) => {
      const verdict = await runAdmission({ env: { ...env, ...extra } })

      expect(verdict).toMatchObject({
        admitted: false,
        refusal: 'undetermined'
      })
      expect(calls).toEqual([])
    }
  )
})
