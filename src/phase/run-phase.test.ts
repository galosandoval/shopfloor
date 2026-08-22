/**
 * Wiring for the one verb. Every decision it makes is tested pure next door —
 * what is tested here is the sequencing itself, which is the whole reason this
 * verb exists: that admission is re-asked rather than assumed, that a refusal
 * writes nothing, that the branch and the PR are located before they are
 * created, and that no way out of a started run leaves the issue in flight.
 *
 * The seams stubbed are this shell's own process boundary and the sibling
 * shells it composes; the pure functions behind them stay real, so a test can
 * never assert a sequence a run would not actually produce.
 */

import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import {
  calls,
  execStubModule,
  resetExecStub,
  respondWith,
  routeExecStub
} from '../process/exec-stub.test-helper'
import { ImplementAgentError } from '../orchestration/implement-error'
import { runImplementAgent } from '../orchestration/implement'
import { runPreflight } from '../guardrails/run-preflight'
import { runLabelVocabularyCheck } from '../guardrails/run-label-vocabulary'
import { postVerifyComment } from '../guardrails/post-verify'
import { applyLabelTransition } from '../issue-state/apply-transition'
import { runAdmission } from '../trigger/run-admission'
import { agentBranchForIssue } from '../trigger/branch'
import { DEFAULT_PHASE_PROMPTS } from './prompts'
import { ensureAgentBranch, pushAgentBranch } from './run-branch'
import { ensurePullRequest } from './run-pull-request'
import { describeRunawayKill } from '../orchestration/spawn-claude'
import { stripAttempts, writeHandoff } from '../handoff/run-handoff'
import { runPhase } from './run-phase'

vi.mock('node:child_process', () => execStubModule())
vi.mock('../trigger/run-admission', () => ({ runAdmission: vi.fn() }))
vi.mock('../guardrails/run-preflight', () => ({ runPreflight: vi.fn() }))
vi.mock('../guardrails/run-label-vocabulary', () => ({
  runLabelVocabularyCheck: vi.fn()
}))
vi.mock('../guardrails/post-verify', () => ({ postVerifyComment: vi.fn() }))
vi.mock('../orchestration/implement', () => ({ runImplementAgent: vi.fn() }))
vi.mock('../issue-state/apply-transition', () => ({
  applyLabelTransition: vi.fn()
}))
vi.mock('./run-branch', () => ({
  ensureAgentBranch: vi.fn(),
  pushAgentBranch: vi.fn(),
  headSha: vi.fn()
}))
vi.mock('./run-pull-request', () => ({ ensurePullRequest: vi.fn() }))
vi.mock('../handoff/run-handoff', () => ({
  writeHandoff: vi.fn(),
  stripAttempts: vi.fn()
}))

const admitted = {
  admitted: true as const,
  phase: 'implement' as const,
  edge: 'human' as const,
  issueNumber: 47,
  actor: 'galosandoval',
  repo: 'acme/widgets',
  branch: agentBranchForIssue(47),
  attempt: 1,
  maxAttempts: 3,
  authorizedBy: { via: 'permission' as const, permission: 'write' as const }
}

const env = {
  CLAUDE_CODE_OAUTH_TOKEN: 'token',
  OUTPUT_DIR: '/tmp/shopfloor-test'
}

/** What the outcomes were applied, in order — the sequence under test. */
const outcomes = () =>
  vi.mocked(applyLabelTransition).mock.calls.map(([input]) => input.outcome)

beforeEach(() => {
  vi.clearAllMocks()
  resetExecStub({ stdout: 'One verb\n' })
  vi.mocked(runAdmission).mockResolvedValue(admitted)
  vi.mocked(runPreflight).mockResolvedValue({ verdict: { refused: false } })
  vi.mocked(runLabelVocabularyCheck).mockResolvedValue({ refused: false })
  vi.mocked(applyLabelTransition).mockResolvedValue({
    applied: true,
    transition: { outcome: 'started', add: [], remove: [] }
  })
  vi.mocked(ensureAgentBranch).mockResolvedValue({
    branch: agentBranchForIssue(47),
    created: true
  })
  vi.mocked(runImplementAgent).mockResolvedValue({
    branch: agentBranchForIssue(47),
    commitsAhead: 2,
    transcriptCaptured: true,
    prDescription: 'agent',
    iterations: 1,
    usage: { source: 'none' } as never
  })
  vi.mocked(ensurePullRequest).mockResolvedValue({
    number: '13',
    url: 'https://x/pull/13',
    created: true
  })
  vi.mocked(postVerifyComment).mockResolvedValue({
    posted: true,
    screenshotCount: 0
  })
  vi.mocked(writeHandoff).mockResolvedValue({
    file: '.agent/attempts/900.md',
    written: true,
    committed: true
  })
  vi.mocked(stripAttempts).mockResolvedValue({ stripped: true, removed: 1 })
})

describe('runPhase', () => {
  it('re-checks admission against the payload rather than trusting the caller', async () => {
    const payload = { action: 'labeled' }

    await runPhase({ payload, env, cwd: '/repo', maxAttempts: 5 })

    expect(vi.mocked(runAdmission).mock.calls[0][0]).toMatchObject({
      payload,
      maxAttempts: 5
    })
  })

  it('runs the phase on the branch it located, then opens the PR and hands over', async () => {
    const result = await runPhase({ payload: {}, env, cwd: '/repo' })

    expect(result).toMatchObject({
      ran: true,
      phase: 'implement',
      issueNumber: 47,
      branch: agentBranchForIssue(47),
      outcome: 'succeeded',
      pullRequest: { number: '13', created: true },
      verifyCommentPosted: true
    })

    expect(vi.mocked(runImplementAgent).mock.calls[0][0]).toMatchObject({
      issueNumber: '47',
      issueTitle: 'One verb',
      branch: agentBranchForIssue(47),
      repo: 'acme/widgets',
      promptTemplate: DEFAULT_PHASE_PROMPTS.implement
    })

    expect(outcomes()).toEqual(['started', 'succeeded'])
    expect(vi.mocked(pushAgentBranch)).toHaveBeenCalledWith({
      branch: agentBranchForIssue(47),
      cwd: '/repo'
    })
    expect(vi.mocked(ensurePullRequest).mock.calls[0][0]).toMatchObject({
      issueNumber: 47,
      issueTitle: 'One verb',
      branch: agentBranchForIssue(47),
      repo: 'acme/widgets'
    })
  })

  it('posts verify against the PR it opened and the commit it pushed', async () => {
    respondWith({ stdout: 'One verb\n' })

    await runPhase({ payload: {}, env, cwd: '/repo' })

    expect(vi.mocked(postVerifyComment).mock.calls[0][0]).toMatchObject({
      prNumber: '13',
      repo: 'acme/widgets',
      issueNumber: '47'
    })
  })

  it('reuses a branch and a PR a retrigger lands on', async () => {
    vi.mocked(ensureAgentBranch).mockResolvedValue({
      branch: agentBranchForIssue(47),
      created: false
    })
    vi.mocked(ensurePullRequest).mockResolvedValue({
      number: '13',
      url: 'https://x/pull/13',
      created: false
    })

    const result = await runPhase({ payload: {}, env, cwd: '/repo' })

    expect(result).toMatchObject({
      ran: true,
      pullRequest: { number: '13', created: false }
    })
  })

  it('writes nothing at all when admission refuses', async () => {
    vi.mocked(runAdmission).mockResolvedValue({
      admitted: false,
      refusal: 'in-flight',
      reason: 'a run is already going'
    })

    const result = await runPhase({ payload: {}, env, cwd: '/repo' })

    expect(result).toEqual({
      ran: false,
      refusal: 'in-flight',
      reason: 'a run is already going'
    })
    expect(vi.mocked(applyLabelTransition)).not.toHaveBeenCalled()
    expect(vi.mocked(runImplementAgent)).not.toHaveBeenCalled()
    expect(vi.mocked(ensureAgentBranch)).not.toHaveBeenCalled()
  })

  it('leaves a preflight refusal to the transition preflight already applied', async () => {
    vi.mocked(runPreflight).mockResolvedValue({
      verdict: { refused: true, reason: 'this issue is a PRD' }
    })

    const result = await runPhase({ payload: {}, env, cwd: '/repo' })

    expect(result).toEqual({
      ran: false,
      refusal: 'preflight',
      reason: 'this issue is a PRD'
    })
    expect(outcomes()).toEqual([])
    expect(vi.mocked(runImplementAgent)).not.toHaveBeenCalled()
  })

  it('does not let preflight refuse a retrigger over the loop own PR', async () => {
    // Preflight refuses an issue an open PR already targets. On the machine
    // edge that PR is this loop's, from the attempt being continued, so asking
    // the question there would refuse every continuation on the evidence that
    // the previous attempt worked.
    vi.mocked(runAdmission).mockResolvedValue({ ...admitted, edge: 'machine' })

    const result = await runPhase({ payload: {}, env, cwd: '/repo' })

    expect(result.ran).toBe(true)
    expect(vi.mocked(runPreflight)).not.toHaveBeenCalled()
  })

  it('verifies the label vocabulary itself on the edge that skips preflight', async () => {
    // No transition is applied without that check in front of it. On the human
    // edge preflight makes it; the machine edge has to make it here, because
    // the run own preconditions only reach it after `started` was written.
    vi.mocked(runAdmission).mockResolvedValue({ ...admitted, edge: 'machine' })
    vi.mocked(runLabelVocabularyCheck).mockResolvedValue({
      refused: true,
      reason: 'the repository carries none of the six labels',
      missing: ['ready-for-human']
    })

    await expect(runPhase({ payload: {}, env, cwd: '/repo' })).rejects.toThrow(
      /six labels/
    )

    expect(vi.mocked(applyLabelTransition)).not.toHaveBeenCalled()
  })

  it('spawns on PROMPT_FILE when the environment names one', async () => {
    // The variable every scaffolded workflow already sets. Keyed prompts did
    // not retire it — it applies to whichever phase the payload discovered —
    // and a value nothing carried into the spawn is the shape `docs/testing.md`
    // opens with.
    const file = path.join(
      fs.mkdtempSync(path.join(os.tmpdir(), 'shopfloor-prompt-')),
      'prompt.md'
    )
    fs.writeFileSync(file, 'the consumer own prompt')

    await runPhase({
      payload: {},
      env: { ...env, PROMPT_FILE: file },
      cwd: '/repo'
    })

    expect(vi.mocked(runImplementAgent).mock.calls[0][0]).toMatchObject({
      promptTemplate: 'the consumer own prompt'
    })
  })

  it('refuses when PROMPT_FILE names a file it cannot read', async () => {
    await expect(
      runPhase({
        payload: {},
        env: { ...env, PROMPT_FILE: '/nope/missing.md' },
        cwd: '/repo'
      })
    ).rejects.toThrow(/PROMPT_FILE/)

    expect(vi.mocked(applyLabelTransition)).not.toHaveBeenCalled()
  })

  it('refuses at startup when the phase has no prompt, before anything is written', async () => {
    await expect(
      runPhase({ payload: {}, env, cwd: '/repo', prompts: { implement: '' } })
    ).rejects.toThrow(/implement/)

    expect(vi.mocked(applyLabelTransition)).not.toHaveBeenCalled()
    expect(vi.mocked(runPreflight)).not.toHaveBeenCalled()
  })

  it('transitions a crashed run to failed and still throws', async () => {
    vi.mocked(runImplementAgent).mockRejectedValue(
      new ImplementAgentError('the CLI exited 1')
    )

    await expect(runPhase({ payload: {}, env, cwd: '/repo' })).rejects.toThrow(
      'the CLI exited 1'
    )

    expect(outcomes()).toEqual(['started', 'failed'])
    expect(vi.mocked(ensurePullRequest)).not.toHaveBeenCalled()
  })

  it('pushes what a failed run committed, so the work outlives the runner', async () => {
    vi.mocked(runImplementAgent).mockRejectedValue(
      new ImplementAgentError('the CLI exited 1')
    )

    await expect(runPhase({ payload: {}, env, cwd: '/repo' })).rejects.toThrow(
      'the CLI exited 1'
    )

    expect(vi.mocked(pushAgentBranch)).toHaveBeenCalledWith({
      branch: agentBranchForIssue(47),
      cwd: '/repo'
    })
  })

  it('reports the run failure, not a push that failed on the way out', async () => {
    vi.mocked(runImplementAgent).mockRejectedValue(
      new ImplementAgentError('the CLI exited 1')
    )
    vi.mocked(pushAgentBranch).mockRejectedValue(new Error('no remote'))
    vi.spyOn(console, 'warn').mockImplementation(() => {})

    await expect(runPhase({ payload: {}, env, cwd: '/repo' })).rejects.toThrow(
      'the CLI exited 1'
    )

    expect(outcomes()).toEqual(['started', 'failed'])
  })

  it('keeps a spent ceiling apart from a crash on the way out', async () => {
    vi.mocked(runImplementAgent).mockRejectedValue(
      new ImplementAgentError('the gate still failed', undefined, undefined, {
        exhausted: true
      })
    )

    await expect(runPhase({ payload: {}, env, cwd: '/repo' })).rejects.toThrow(
      'the gate still failed'
    )

    expect(outcomes()).toEqual(['started', 'exhausted'])
  })

  it('says on the issue which invariants blocked the run (shopfloor#48)', async () => {
    vi.mocked(runImplementAgent).mockRejectedValue(
      new ImplementAgentError(
        'the trajectory does not close',
        undefined,
        undefined,
        {
          closure: {
            kind: 'block',
            cause: 'violation',
            violations: ['gate-before-commit'],
            reason: 'the trajectory does not close'
          }
        }
      )
    )

    await expect(runPhase({ payload: {}, env, cwd: '/repo' })).rejects.toThrow(
      'the trajectory does not close'
    )

    expect(outcomes()).toEqual(['started', 'failed'])
    const comment = calls.find(
      (call) => call[0] === 'gh' && call[1] === 'issue' && call[2] === 'comment'
    )
    expect(comment?.join(' ')).toContain('gate-before-commit')
  })

  it('says which invariants blocked it even when the transition then fails', async () => {
    // The comment holds the only copy of that list a human sees on the issue,
    // and the transition is a `gh` call of its own that can fail — so it is
    // said first. Ordered the other way, the failure that matters most to
    // report is the one that takes the report with it.
    vi.mocked(runImplementAgent).mockRejectedValue(
      new ImplementAgentError(
        'the trajectory does not close',
        undefined,
        undefined,
        {
          closure: {
            kind: 'block',
            cause: 'violation',
            violations: ['red-before-green'],
            reason: 'the trajectory does not close'
          }
        }
      )
    )
    vi.mocked(applyLabelTransition).mockImplementation(async ({ outcome }) => {
      if (outcome !== 'started') throw new Error('gh: label write failed')
      return { applied: true, transition: { outcome, add: [], remove: [] } }
    })

    await expect(runPhase({ payload: {}, env, cwd: '/repo' })).rejects.toThrow(
      'gh: label write failed'
    )

    const comment = calls.find(
      (call) => call[0] === 'gh' && call[1] === 'issue' && call[2] === 'comment'
    )
    expect(comment?.join(' ')).toContain('red-before-green')
  })

  it('reports the run failure, not a comment that failed on the way out', async () => {
    vi.mocked(runImplementAgent).mockRejectedValue(
      new ImplementAgentError('no readable transcript', undefined, undefined, {
        closure: {
          kind: 'block',
          cause: 'no-evidence',
          violations: [],
          reason: 'no readable transcript'
        }
      })
    )
    // The title probe still answers; only the comment fails.
    routeExecStub([{ match: /gh issue comment/, response: { fails: 1 } }])
    vi.spyOn(console, 'warn').mockImplementation(() => {})

    await expect(runPhase({ payload: {}, env, cwd: '/repo' })).rejects.toThrow(
      'no readable transcript'
    )

    expect(outcomes()).toEqual(['started', 'failed'])
  })

  it('refuses when the issue title cannot be read, before the run starts', async () => {
    respondWith({ fails: 1 })

    await expect(runPhase({ payload: {}, env, cwd: '/repo' })).rejects.toThrow(
      /title of issue #47/
    )

    expect(outcomes()).toEqual([])
    expect(calls.some((call) => call[0] === 'gh')).toBe(true)
  })
})

/**
 * The handoff artifact (shopfloor#49). The document is tested pure in
 * `handoff.test.ts` and the writing shell in `run-handoff.test.ts`; what is
 * tested here is the sequencing — that a failure writes one before the branch
 * is pushed, that a killed run still gets one, and that a success strips the
 * trail instead of adding to it.
 */
describe('runPhase — the handoff trail', () => {
  const failWith = (error: unknown) =>
    vi.mocked(runImplementAgent).mockRejectedValue(error)

  const handoff = () => vi.mocked(writeHandoff).mock.calls[0][0]

  beforeEach(() => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    // `clearAllMocks` clears calls, not implementations — an earlier suite's
    // rejecting push would otherwise leak into every test here.
    vi.mocked(pushAgentBranch).mockResolvedValue(undefined)
  })

  it('writes and commits one when the run fails, before the branch is pushed', async () => {
    failWith(new ImplementAgentError('Claude CLI exited with status 1.'))

    await expect(runPhase({ payload: {}, env, cwd: '/repo' })).rejects.toThrow()

    expect(handoff()).toMatchObject({
      attempt: 1,
      maxAttempts: 3,
      issueNumber: 47,
      repo: 'acme/widgets',
      branch: agentBranchForIssue(47),
      outcome: 'failed',
      failure: 'Claude CLI exited with status 1.',
      attemptsDir: '.agent/attempts'
    })
    expect(vi.mocked(writeHandoff).mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(pushAgentBranch).mock.invocationCallOrder[0]
    )
  })

  it('writes one for a run its runaway guards killed', async () => {
    // The real message, not a stand-in: a kill is the case this artifact exists
    // for, and asserting on prose no run would print would prove nothing.
    failWith(
      new ImplementAgentError(
        describeRunawayKill({ reason: 'wall-clock', budgetMs: 900_000 })
      )
    )

    await expect(runPhase({ payload: {}, env, cwd: '/repo' })).rejects.toThrow()

    expect(handoff().failure).toContain('killed by the')
    expect(outcomes()).toEqual(['started', 'failed'])
  })

  it('records an exhausted ceiling as exhausted rather than as a failure', async () => {
    failWith(
      new ImplementAgentError(
        'Spent 3 iterations with the gate red.',
        undefined,
        undefined,
        {
          exhausted: true
        }
      )
    )

    await expect(runPhase({ payload: {}, env, cwd: '/repo' })).rejects.toThrow()

    expect(handoff().outcome).toBe('exhausted')
  })

  it('carries the scorecard the failed attempt was graded on', async () => {
    const findings = [
      {
        id: 'gate-before-commit' as const,
        title: 'Quality gate ran before each commit',
        status: 'fail' as const,
        detail: 'committed 3 times, gate ran 0 times',
        evidence: [{ turnIndex: 4 }]
      }
    ]
    failWith(
      new ImplementAgentError('blocked', undefined, undefined, { findings })
    )

    await expect(runPhase({ payload: {}, env, cwd: '/repo' })).rejects.toThrow()

    expect(handoff().scorecard).toEqual(findings)
  })

  it('carries the CI failure the machine edge continues', async () => {
    vi.mocked(runAdmission).mockResolvedValue({
      ...admitted,
      edge: 'machine',
      ciFailure: {
        runId: '4242',
        runUrl: 'https://github.com/acme/widgets/actions/runs/4242'
      }
    })
    failWith(new ImplementAgentError('failed'))

    await expect(runPhase({ payload: {}, env, cwd: '/repo' })).rejects.toThrow()

    expect(handoff().ciFailure).toMatchObject({ runId: '4242' })
  })

  it('strips the trail on success, and writes no handoff for it', async () => {
    const result = await runPhase({ payload: {}, env, cwd: '/repo' })

    expect(result).toMatchObject({ ran: true, outcome: 'succeeded' })
    expect(vi.mocked(stripAttempts)).toHaveBeenCalledWith({
      attemptsDir: '.agent/attempts',
      cwd: '/repo'
    })
    expect(vi.mocked(writeHandoff)).not.toHaveBeenCalled()
  })

  it('keeps the trail on every ending that is not a success', async () => {
    failWith(new ImplementAgentError('failed'))

    await expect(runPhase({ payload: {}, env, cwd: '/repo' })).rejects.toThrow()

    expect(vi.mocked(stripAttempts)).not.toHaveBeenCalled()
  })

  it('does not let a failed handoff replace the failure worth reporting', async () => {
    vi.mocked(writeHandoff).mockRejectedValue(new Error('disk full'))
    failWith(new ImplementAgentError('Claude CLI exited with status 1.'))

    await expect(runPhase({ payload: {}, env, cwd: '/repo' })).rejects.toThrow(
      'Claude CLI exited with status 1.'
    )
    expect(outcomes()).toEqual(['started', 'failed'])
  })
})
