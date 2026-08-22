/**
 * **One verb** (shopfloor#47, design §2): `runPhase(rawEvent)` classifies the
 * event, re-checks admission, resolves the phase's prompt, refuses what
 * preflight refuses, locates or creates the branch, runs the phase, locates or
 * opens the pull request, reports, and transitions the issue's state.
 *
 * **Why one.** The verb count was never the interface — the *sequencing* was,
 * and it lived in 323 lines of consumer YAML with three `|| true` blocks and a
 * transition that had never once fired. Everything this file does used to be
 * bash between four verbs; what changes is not how much the package does but
 * where the order of it can be typed, tested, and read in one sitting.
 *
 * **Admission is re-checked here, not trusted** (design review finding 2). The
 * setup-free `shopfloor-admit` job (shopfloor#46) still runs first, because a
 * spend gate behind the spend it guards is not a gate; this call re-asks the
 * same question against the same payload, so a run reached by any other path —
 * a caller who skipped the job, a workflow edited later — is judged rather
 * than admitted by assumption.
 *
 * **Every decision it makes is next door and pure.** Which prompt a phase
 * spawns with is `prompts.ts`; what the PR says is `pull-request.ts`; what
 * state a finished run leaves the issue in is `outcome.ts`; which branch this
 * is, is `trigger/branch.ts` — the one place that name is written down, and the
 * reason the consumer's slug pipeline is deleted rather than duplicated here.
 */

import * as fs from 'node:fs'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { postVerifyComment } from '../guardrails/post-verify'
import { runPreflight } from '../guardrails/run-preflight'
import { runLabelVocabularyCheck } from '../guardrails/run-label-vocabulary'
import { applyLabelTransition } from '../issue-state/apply-transition'
import {
  commentOnIssueBestEffort,
  type IssueRef
} from '../issue-state/issue-comment'
import type { FailedPhaseOutcome, RunOutcome } from '../issue-state/transition'
import {
  resolveImplementConfig,
  type ResolvedImplementConfig,
  type RunImplementAgentConfig
} from '../orchestration/config'
import { ImplementAgentError } from '../orchestration/implement-error'
import type { ClosureBlock } from '../guardrails/closure'
import {
  runImplementAgent,
  type RunImplementAgentResult
} from '../orchestration/implement'
import type { AdmissionRefusal } from '../trigger/admission'
import type { Phase, TriggerEdge } from '../trigger/classify'
import { runAdmission } from '../trigger/run-admission'
import { writeHandoff, type WriteHandoffInput } from '../handoff/run-handoff'
import type { AttemptsTrailLocation } from '../handoff/git'
import { stripAttempts } from '../handoff/strip-attempts'
import { evaluatePhaseOutcome } from './outcome'
import { resolvePhasePrompt } from './prompts'
import { ensureAgentBranch, headSha, pushAgentBranch } from './run-branch'
import { ensurePullRequest } from './run-pull-request'

const execFileAsync = promisify(execFile)

/**
 * What a caller states about a phase run. Everything an implement run accepts
 * is still accepted, minus the four values the payload now decides — the
 * issue, its title, the branch, and the repository. Passing them would be
 * stating what the event already says, which is the two-components-one-identity
 * shape this verb exists to collapse.
 */
export interface RunPhaseInput extends Omit<
  RunImplementAgentConfig,
  'promptTemplate' | 'issueNumber' | 'issueTitle' | 'branch' | 'repo'
> {
  /**
   * The raw webhook payload, already parsed. Omitted means read it from
   * `GITHUB_EVENT_PATH`, which is where the runner puts it.
   */
  payload?: unknown
  /**
   * Prompts by phase. Unstated for a phase, the shipped shim runs — see
   * `prompts.ts`. A single `PROMPT_FILE` in the environment still works and
   * applies to whichever phase the payload discovered.
   */
  prompts?: Partial<Record<Phase, string>>
  /** Overrides the package's attempt ceiling, as `shopfloor-admit` does. */
  maxAttempts?: number
}

export type RunPhaseResult =
  | {
      ran: false
      /**
       * `preflight` alongside admission's own kinds: the two refuse for
       * different reasons and leave the issue in different states — an
       * admission refusal writes nothing at all, while preflight has already
       * applied the `refused` transition and said why on the issue.
       */
      refusal: AdmissionRefusal | 'preflight'
      reason: string
    }
  | {
      ran: true
      phase: Phase
      edge: TriggerEdge
      issueNumber: number
      repo: string
      branch: string
      attempt: number
      maxAttempts: number
      pullRequest: { number: string; url: string; created: boolean }
      /** Always `succeeded` — every other outcome leaves by throwing. */
      outcome: RunOutcome
      run: RunImplementAgentResult
      /** Verify is best-effort by contract and never fails a run. */
      verifyCommentPosted: boolean
    }

/**
 * Run whatever phase this event starts.
 *
 * **Refusals write nothing, except the one that already did.** An admission
 * refusal — a stranger, an unreadable probe, a run already in flight, a spent
 * ceiling — leaves the issue exactly as it found it, the same rule
 * `runAdmission` follows: a refusal that labelled would hand any drive-by
 * triager a way to make the harness write to the repository, and the in-flight
 * case would have this run edit an issue another run owns. Preflight is the
 * exception because its refusal *is* a judgement about the issue, and it has
 * applied the table's `refused` row and commented before returning.
 *
 * **A failed run still transitions.** The outcome is applied and the error
 * rethrown, so a caller's CI glue keeps its non-zero exit while the issue
 * stops sitting in `agent:in-progress` forever — the state a run that dies
 * without transitioning leaves behind, and one of the two things the bash
 * layer got wrong.
 */
export async function runPhase(
  input: RunPhaseInput = {}
): Promise<RunPhaseResult> {
  const env = input.env ?? process.env
  const cwd = input.cwd ?? process.cwd()

  const admission = await runAdmission({
    payload: input.payload,
    env,
    maxAttempts: input.maxAttempts
  })

  if (!admission.admitted) {
    return { ran: false, refusal: admission.refusal, reason: admission.reason }
  }

  const { phase, edge, issueNumber, repo, attempt, maxAttempts } = admission
  // The issue, as everything downstream needs it: `gh` takes the number as a
  // string, and re-stringifying it at each of six call sites is where a
  // number/string flip-flop would eventually disagree with itself.
  const issue: IssueRef = { issueNumber: String(issueNumber), repo }
  const promptTemplate = requirePhasePrompt(phase, input, env)

  // **Preflight asks whether this issue should be *started*, so only the human
  // edge asks it.** Its third refusal is "an open PR already targets this
  // issue" — which on a retrigger is the loop's own PR, the one this run has
  // to iterate on. Running it on the machine edge would refuse every
  // continuation on the evidence that the previous attempt worked.
  //
  // It is also what verifies the label vocabulary for everything below: it
  // refuses the whole verb when the six labels are missing, so no transition
  // here is applied against a repository that cannot carry it (shopfloor#45).
  // The machine edge skips preflight and therefore has to make that check for
  // itself — the run's own preconditions make it too, but only *after* the
  // `started` row below, and a package invariant is that no transition is
  // applied without it (`CONTEXT.md`).
  if (edge === 'human') {
    const preflight = await runPreflight(issue)
    if (preflight.verdict.refused) {
      return {
        ran: false,
        refusal: 'preflight',
        reason: preflight.verdict.reason
      }
    }
  } else {
    await requireLabelVocabulary(repo, cwd)
  }

  const issueTitle = await probeIssueTitle(issueNumber, repo, cwd)

  // The run is in flight from here: the issue says so before the branch
  // exists, so a run killed between the two is still visible as one that
  // started rather than as one that never happened.
  await applyLabelTransition({ ...issue, outcome: 'started' })

  const { branch } = await ensureAgentBranch({ issueNumber, cwd })

  const runInput: RunImplementAgentConfig = {
    ...input,
    ...issue,
    issueTitle,
    branch,
    repo,
    promptTemplate,
    env,
    cwd
  }
  const config = resolveImplementConfig(runInput, env)

  const run = await runPhaseAgent(runInput, {
    issue,
    branch,
    cwd,
    handoff: {
      attempt,
      maxAttempts,
      issueNumber,
      repo,
      branch,
      ...(admission.ciFailure ? { ciFailure: admission.ciFailure } : {}),
      attemptsDir: config.attemptsDir,
      claimsFile: config.handoffClaimsFile,
      cwd,
      env
    }
  })

  // **The trail is stripped here, on the one path that ends it.** A run that
  // closed as a success has no next attempt to inform, and the strip is a
  // commit — so it goes before `handOver` pushes, riding out with the work
  // rather than in a follow-up push. Every other ending keeps the trail: an
  // exhausted issue keeps it because §4 posts it to a human, and a failed one
  // keeps it because the next attempt is the whole reason it was written.
  //
  // Nothing strips the verify screenshots yet — shopfloor#49 specified this
  // point as "where the screenshots are stripped", and that place does not
  // exist. When it does, it belongs on this line, for the same reason: a
  // deletion that misses the pushed commit leaves the branch carrying it.
  await stripAttemptsBestEffort({ attemptsDir: config.attemptsDir, cwd })

  const { pullRequest, verifyCommentPosted } = await handOver({
    issue,
    issueTitle,
    branch,
    config,
    env,
    cwd
  })

  return {
    ran: true,
    phase,
    edge,
    issueNumber,
    repo,
    branch,
    attempt,
    maxAttempts,
    pullRequest,
    outcome: 'succeeded',
    run,
    verifyCommentPosted
  }
}

/**
 * Everything between a finished run and a human owning it: push what was
 * committed, locate or open the draft PR, post the verify proof, and set
 * `ready-for-human`.
 *
 * One function because the four steps only make sense in this order and none
 * of them decides anything — the order is the point, and it is what used to be
 * bash.
 */
async function handOver(context: {
  issue: IssueRef
  issueTitle: string
  branch: string
  config: ResolvedImplementConfig
  env: NodeJS.ProcessEnv
  cwd: string
}): Promise<{
  pullRequest: { number: string; url: string; created: boolean }
  verifyCommentPosted: boolean
}> {
  const { issue, branch, config, cwd } = context

  await pushAgentBranch({ branch, cwd })

  const pullRequest = await ensurePullRequest({
    issueNumber: Number(issue.issueNumber),
    issueTitle: context.issueTitle,
    repo: issue.repo,
    branch,
    prDescriptionFile: config.prDescriptionFile,
    cwd
  })

  const verify = await postVerifyComment({
    ...issue,
    prNumber: pullRequest.number,
    // The commit the run just pushed, not `GITHUB_SHA` — that names the commit
    // the *workflow* started on, which on this path is a branch tip several
    // commits behind the screenshots the comment links to.
    sha: await headSha(cwd),
    branch,
    verifyReportFile: config.verifyReportFile,
    screenshotsDir: config.screenshotsDir,
    env: context.env,
    cwd
  })

  await applyLabelTransition({
    ...issue,
    outcome: evaluatePhaseOutcome({ failed: false })
  })

  return { pullRequest, verifyCommentPosted: verify.posted }
}

/**
 * The six labels the rows below are written against, verified and never
 * created — the write belongs to `shopfloor init`, at a moment a human asked
 * for it (shopfloor#45).
 */
async function requireLabelVocabulary(
  repo: string,
  cwd: string
): Promise<void> {
  const verdict = await runLabelVocabularyCheck({ repo, cwd })
  if (verdict.refused) throw new ImplementAgentError(verdict.reason)
}

/**
 * The phase's run, with its failure transitioned before it is rethrown. The
 * transition is applied on the way out rather than by the caller because a
 * caller is exactly what used to own it — in bash, behind `|| true`.
 */
async function runPhaseAgent(
  runInput: RunImplementAgentConfig,
  context: PhaseRunContext
): Promise<RunImplementAgentResult> {
  try {
    return await runImplementAgent(runInput)
  } catch (error) {
    const outcome = evaluatePhaseOutcome({
      failed: true,
      exhausted: error instanceof ImplementAgentError ? error.exhausted : false
    })

    // **First, because this is the run the next attempt has to learn from**
    // (shopfloor#49). Why the harness half is written on every failing path —
    // kill, crash, exhausted ceiling alike — is on `renderHandoff`; what this
    // ordering adds is that it lands *before* the push below, so the branch
    // actually carries it. Best-effort, like the push: a handoff that fails to
    // write must not replace the failure worth reporting.
    await writeHandoffBestEffort(context, error, outcome)

    // **The work survives the runner even when the run does not.** A failed or
    // exhausted run has usually committed something, and an ephemeral runner
    // takes it with it — so the human this is about to summon would arrive at
    // an issue labelled `agent:blocked` with nothing to read. Best-effort and
    // last-but-one: a push that itself fails must not replace the failure that
    // is actually worth reporting. No PR is opened, because unvetted work is
    // not a pull request; the branch is there to be looked at.
    await pushBestEffort(context)

    // Said before the transition, not after: the transition is a `gh` call
    // that can itself fail, and it is the *comment* that carries the only copy
    // of the violated invariants a human ever sees on the issue. Losing the
    // label leaves an issue mislabelled; losing the comment leaves
    // `agent:blocked` with no statement of what blocked it.
    if (error instanceof ImplementAgentError && error.closure) {
      await commentOnClosureBlock(context, error.closure)
    }

    await applyLabelTransition({ ...context.issue, outcome })

    throw error
  }
}

/**
 * What the failure path needs about the run in flight — the values that have
 * travelled together since this file existed, named once rather than respelled
 * at each helper below.
 */
interface PhaseRunContext {
  issue: IssueRef
  branch: string
  cwd: string
  /** Everything the handoff needs that this shell settled before the run. */
  handoff: Omit<WriteHandoffInput, 'outcome' | 'failure' | 'scorecard'>
}

/**
 * Write and commit this attempt's handoff, reporting its own failures rather
 * than raising them.
 *
 * The scorecard rides in on the error when one was graded (shopfloor#49) —
 * absent means the attempt was never graded, which the document states rather
 * than rendering as a clean sheet.
 */
async function writeHandoffBestEffort(
  context: PhaseRunContext,
  error: unknown,
  outcome: FailedPhaseOutcome
): Promise<void> {
  const implementError =
    error instanceof ImplementAgentError ? error : undefined

  try {
    const result = await writeHandoff({
      ...context.handoff,
      outcome,
      failure: error instanceof Error ? error.message : String(error),
      ...(implementError?.findings
        ? { scorecard: implementError.findings }
        : {})
    })

    // **Said as a consequence, not as a step that did not happen.** A handoff
    // that stayed on the runner's disk is a handoff the next attempt will never
    // see, and the loop then spends an attempt re-deriving what this one already
    // learned — the exact failure #49 exists to prevent, and one that is
    // otherwise invisible until somebody reads three near-identical attempts.
    if (!result.written || !result.committed) {
      console.warn(
        `Handoff for attempt ${context.handoff.attempt} did not reach ` +
          `${context.branch} (${result.detail ?? 'no reason given'}) — the ` +
          'next attempt on this issue will start with no memory of this one.'
      )
    }
  } catch (handoffError) {
    console.warn(
      `Could not write the handoff (${String(handoffError)}) — the next ` +
        'attempt on this issue will start with no memory of this one.'
    )
  }
}

/** The success path's strip, whose own failure is reported and then dropped. */
async function stripAttemptsBestEffort(
  input: AttemptsTrailLocation
): Promise<void> {
  try {
    const result = await stripAttempts(input)
    if (result.detail)
      console.warn(`Could not strip the trail: ${result.detail}`)
  } catch (error) {
    console.warn(`Could not strip the trail: ${String(error)}`)
  }
}

/**
 * Say on the issue why the trajectory blocked this run (shopfloor#48).
 *
 * `agent:blocked` says a human is needed; it does not say what for, and the
 * one thing this failure has that the others do not is a stated list of
 * invariants the run violated. Without the comment that list reaches only the
 * failure-reason artifact, which is on the CI run rather than on the issue the
 * human is looking at.
 *
 * Best-effort, like every other report this package writes: a comment that
 * fails to post must not replace the failure worth reporting.
 */
async function commentOnClosureBlock(
  context: PhaseRunContext,
  closure: ClosureBlock
): Promise<void> {
  const violated =
    closure.violations.length > 0
      ? `\n\n**Violated:** ${closure.violations.map((id) => `\`${id}\``).join(', ')}`
      : ''

  await commentOnIssueBestEffort(
    context.issue,
    `The implement phase blocked this run on its own trajectory.\n\n` +
      `**Reason:** ${closure.reason}${violated}\n\n` +
      `What the run committed is on \`${context.branch}\`; no pull ` +
      'request was opened for it.',
    'the closure block'
  )
}

/** A push whose own failure is reported and then dropped — see its caller. */
async function pushBestEffort(context: PhaseRunContext): Promise<void> {
  try {
    await pushAgentBranch({ branch: context.branch, cwd: context.cwd })
  } catch (error) {
    console.warn(
      `Could not push ${context.branch} after a failed run: ${String(error)}`
    )
  }
}

/**
 * The prompt for the discovered phase, refusing **at startup** when nothing
 * resolves one — before the branch, before the transition, and before a token
 * is spent. A phase that failed at spawn time instead would leave an issue
 * labelled in-flight over a run that never had anything to say.
 */
function requirePhasePrompt(
  phase: Phase,
  input: RunPhaseInput,
  env: NodeJS.ProcessEnv
): string {
  const verdict = resolvePhasePrompt({
    phase,
    stated: input.prompts ?? statedPromptFile(phase, env)
  })

  if (!verdict.resolved) throw new ImplementAgentError(verdict.reason)
  return verdict.prompt
}

/**
 * `PROMPT_FILE`, kept working now that prompts are keyed by phase: it applies
 * to whichever phase the payload discovered. One file cannot serve two phases,
 * so a consumer running more than one states `prompts` instead — and until a
 * second phase ships, the variable every consumer's workflow already sets
 * means exactly what it did.
 */
function statedPromptFile(
  phase: Phase,
  env: NodeJS.ProcessEnv
): Partial<Record<Phase, string>> | undefined {
  const file = env.PROMPT_FILE
  if (!file) return undefined

  try {
    return { [phase]: fs.readFileSync(file, 'utf8') } as Partial<
      Record<Phase, string>
    >
  } catch {
    throw new ImplementAgentError(
      `Could not read PROMPT_FILE (${file}) for the ${phase} phase — fix the ` +
        'path, or unset it to run on the prompt this package ships.'
    )
  }
}

/**
 * The issue's own title: the PR is named after the work rather than after the
 * branch, and the prompt says which issue it is implementing. Probed once here
 * and handed to both, so the two can never disagree.
 */
async function probeIssueTitle(
  issueNumber: number,
  repo: string,
  cwd: string
): Promise<string> {
  try {
    const { stdout } = await execFileAsync(
      'gh',
      [
        'issue',
        'view',
        String(issueNumber),
        '--repo',
        repo,
        '--json',
        'title',
        '-q',
        '.title'
      ],
      { cwd }
    )
    const title = stdout.trim()
    if (title) return title
  } catch {
    // fall through to the refusal below
  }

  throw new ImplementAgentError(
    `Could not read the title of issue #${issueNumber} via gh — the run needs ` +
      'it for the prompt and for the pull request it opens.'
  )
}
