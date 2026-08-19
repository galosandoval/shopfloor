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
  respondWith
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

  it('refuses when the issue title cannot be read, before the run starts', async () => {
    respondWith({ fails: 1 })

    await expect(runPhase({ payload: {}, env, cwd: '/repo' })).rejects.toThrow(
      /title of issue #47/
    )

    expect(outcomes()).toEqual([])
    expect(calls.some((call) => call[0] === 'gh')).toBe(true)
  })
})
