/**
 * Admission (shopfloor#46): the pure half of the one question a setup-free job
 * asks before the runner installs anything — **may this event start a run?**
 *
 * It composes four decisions that already exist or arrive as facts, in the
 * order that costs least: classification (does this event start anything at
 * all), authorization (may this actor spend), the concurrency check (is a run
 * already in flight on this issue), and the attempt ceiling (has this issue
 * already had its runs). One verdict, one reason.
 *
 * **Why this is a phase of its own rather than the front of `runPhase`**
 * (design review finding 2). Authorization is the only guardrail whose failure
 * mode is financial and adversarial, and a single verb that classifies and
 * authorizes *after* the runner has installed dependencies runs the spend gate
 * after the spend. On a public repository that means an unauthorized actor
 * forces full runner setup on every label event. So the sequencing knowledge
 * becomes typed and tested — that was always the point — while the gate stays
 * in front of the cost it guards.
 *
 * **It refuses on uncertainty, like the spend gate it wraps and unlike every
 * other guard in this package.** An unreadable issue is not "probably no
 * attempts": it is not knowing whether a run is already spending on this
 * issue, or whether the ceiling is already spent. Both unknowns resolve in the expensive
 * direction, which is the same inversion `evaluateAuthorization` documents,
 * for the same reason.
 *
 * **Both counts come from the issue, and that reverses design §4 and §7.**
 * Those sections derive the ceiling and the concurrency check from
 * `gh run list --branch`, on the reasoning that a label is state the harness
 * would then have to keep consistent. The mechanism does not work: a workflow
 * run triggered by `issues.labeled` — or by `workflow_run` — executes on the
 * **default branch**, so its `head_branch` is `main` and a list filtered by
 * `agent/issue-<n>` is empty on every real run. Checked against the live
 * consumer: every `issues`-triggered run of its agent workflow reports
 * `headBranch: main`, and the only per-issue handle on a run is
 * `displayTitle` — the issue title, editable prose. Derived-don't-store was
 * argued against an alternative that cannot fire, so it loses here.
 *
 * What replaces it needs nothing new written: the `started` transition
 * (shopfloor#45) already adds `agent:in-progress`, and GitHub's issue timeline
 * keeps every `labeled` event **permanently**, after the label is removed and
 * after any `always()` clear. So the count is a fact about history that no
 * later edit can rewrite, and only the in-flight check reads mutable state.
 *
 * **The concurrency check is a narrowing, not a lock** (design review finding
 * 5, recorded here as the decision it asked for). §7 rejected the label as a
 * *lock* and that rejection stands unchanged: a maintainer clearing a stuck
 * `agent:in-progress` by hand silently unlocks concurrent spending, and two
 * events landing together can both read it absent. This closes the window
 * without closing it entirely. GitHub's real mutual exclusion is a
 * `concurrency:` group in the consumer's workflow — the scaffolded one already
 * carries it — and that is where it stays. What changed is only that the
 * cheap narrowing in front of it now reads a signal that exists.
 */

import type {
  AuthorizationVerdict,
  SpendingPermission
} from '../guardrails/authorization'
import { IN_PROGRESS_LABEL } from '../issue-state/vocabulary'
import { agentBranchForIssue } from './branch'
import type { Phase, TriggerClassification, TriggerEdge } from './classify'

/**
 * How many runs one issue gets before the ceiling trips. Design §4 puts this
 * "in `runPolicy` beside `idleMinutes` and `wallClockMinutes`"; it lands here
 * instead, and the difference is not cosmetic: admission runs **before a run
 * exists**, so it never constructs a run policy, and a policy field nothing in
 * a run reads is the shape of guard this repository has already shipped once
 * without wiring it up.
 *
 * Three, for the reason `maxIterations` is three one level down — but bought
 * far more expensively. Each attempt here is a whole runner: install,
 * generate, migrate, browsers, and a full agent run. Two failures a fresh
 * attempt could not fix are usually a wrong spec rather than a near miss, and
 * the terminal state (`agent:exhausted`) exists to say exactly that.
 */
export const DEFAULT_MAX_ATTEMPTS = 3

/**
 * What the issue's own history came back with. Shaped like `PermissionProbe`
 * next door, and for the same reason: an unanswered probe carries **why** it
 * could not answer, so the refusal names a broken token rather than reporting
 * the same sentence for every failure.
 */
export type IssueHistoryProbe =
  | {
      answered: true
      /**
       * Every label ever **added** to the issue, in order, one entry per
       * `labeled` event — so a label added, removed, and added again appears
       * twice. This is what makes the count possible: GitHub keeps the timeline
       * even after the label itself is gone.
       */
      labelAdditions: readonly string[]
      /** The labels on the issue right now. */
      currentLabels: readonly string[]
    }
  | { answered: false; detail: string }

export interface AdmissionInput {
  classification: TriggerClassification
  /**
   * Omitted when the spend gate was never run — which is what a shell does for
   * an event that classified as nothing. An absent verdict refuses on its own
   * terms rather than being inferred from the classification, so the two are
   * not coupled by the order this function checks them in.
   */
  authorization?: AuthorizationVerdict
  /**
   * The issue's label history and current labels — where both the ceiling and
   * the concurrency check are read. Omitted when the probe was never taken,
   * which is what a shell does for an event that was already refused.
   */
  history?: IssueHistoryProbe
  /** Defaults to {@link DEFAULT_MAX_ATTEMPTS}. */
  maxAttempts?: number
}

/**
 * Why an event was refused. Five kinds rather than one boolean, because the
 * human responses are five different things: nothing happened, a stranger
 * tried to spend, a token is broken, a run is already going, and the work is
 * harder than the spec said.
 */
export type AdmissionRefusal =
  /**
   * The spend gate's own two kinds, taken from its type rather than restated:
   * admission passes `authorization.refusal` straight through, so a literal
   * union written out here would typecheck only for as long as two independent
   * lists happened to agree.
   */
  | Extract<AuthorizationVerdict, { authorized: false }>['refusal']
  | 'not-a-trigger'
  | 'in-flight'
  | 'exhausted'

/**
 * The two ways a run gets authorized, and they are not the same question.
 *
 * `permission` — a person triggered this, and the spend gate probed what they
 * may do on the repository (shopfloor#41). This is the human edge.
 *
 * `continuation` — **nobody triggered this**; the loop's own failed run did.
 * There is no login to probe: the run continues work a human-edge admission
 * already authorized, and the payload is what proves it — the harness's own
 * commit author, on the harness's own branch, in the repository itself rather
 * than a fork (design §6). Probing the login instead asks the wrong question
 * and gets a wrong answer: `workflow_run.triggering_actor` is frequently
 * `github-actions[bot]`, whose collaborator permission is `none`, so the one
 * edge with no human on it refused every time.
 *
 * **The fences are the authorization**, so read them as load-bearing rather
 * than as attribution tidiness: pushing to `agent/issue-<n>` in the repository
 * itself already requires write access, which is a spending permission, and
 * the fork check is what keeps that sentence true.
 */
export type AdmissionAuthority =
  | { via: 'permission'; permission: SpendingPermission }
  | { via: 'continuation' }

export type AdmissionVerdict =
  | {
      admitted: true
      phase: Phase
      edge: TriggerEdge
      issueNumber: number
      actor: string
      repo: string
      /** The branch the phase works on — built, not read, on the human edge. */
      branch: string
      /** Which attempt this would be, counting from one. */
      attempt: number
      maxAttempts: number
      /** What admitted it, echoed for the run's own record. */
      authorizedBy: AdmissionAuthority
    }
  | { admitted: false; refusal: AdmissionRefusal; reason: string }

/** Decide whether an event may start a run. */
export function evaluateAdmission(input: AdmissionInput): AdmissionVerdict {
  const { classification } = input

  if (!classification.triggered) {
    return {
      admitted: false,
      refusal: 'not-a-trigger',
      reason: classification.reason
    }
  }

  const { phase, edge, issueNumber, actor, repo } = classification
  const maxAttempts = input.maxAttempts ?? DEFAULT_MAX_ATTEMPTS
  const authorizedBy = authorityFor(classification, input.authorization)

  if (!('via' in authorizedBy)) {
    return { admitted: false, ...authorizedBy }
  }

  const branch = agentBranchForIssue(issueNumber)

  if (!input.history?.answered) {
    const detail = input.history?.detail ?? 'the issue was never read'
    return {
      admitted: false,
      refusal: 'undetermined',
      reason:
        `Could not read issue #${issueNumber}'s label history: ${detail}. So ` +
        'neither the attempt ceiling nor the concurrency check can be ' +
        'answered, and admission refuses on uncertainty: an unreadable history ' +
        'is not an empty one, and starting a second run on an issue that ' +
        'already has one is how two agents end up on one branch. Give the ' +
        `probe a token that can read ${repo}'s issues and retrigger.`
    }
  }

  if (input.history.currentLabels.includes(IN_PROGRESS_LABEL)) {
    return {
      admitted: false,
      refusal: 'in-flight',
      reason:
        `Issue #${issueNumber} is labeled "${IN_PROGRESS_LABEL}", so a run is ` +
        `already going on ${branch}. A second one would put two agents on one ` +
        'working tree. Wait for it to finish; if it died without cleaning up, ' +
        'remove the label and retrigger.'
    }
  }

  const attempts = input.history.labelAdditions.filter(
    (label) => label === IN_PROGRESS_LABEL
  ).length

  if (attempts >= maxAttempts) {
    return {
      admitted: false,
      refusal: 'exhausted',
      reason:
        `Issue #${issueNumber} has already had ${describeRuns(attempts)}, and ` +
        `the ceiling is ${maxAttempts}. The work is harder than the spec said, ` +
        "or the spec is wrong — either way the next move is a human's. Raise " +
        'the ceiling deliberately if another run is worth paying for.'
    }
  }

  return {
    admitted: true,
    phase,
    edge,
    issueNumber,
    actor,
    repo,
    branch,
    attempt: attempts + 1,
    maxAttempts,
    authorizedBy
  }
}

/**
 * Which of the two authorities admits this event, or the refusal that says
 * neither does. Split out because the two edges ask different questions and
 * the difference is the whole of shopfloor#46's correction: the human edge
 * needs a probed permission and refuses without one, and the machine edge has
 * no login worth probing — {@link classifyTrigger} already refused anything
 * that was not the harness's own commit, on its own branch, in the repository
 * itself.
 */
function authorityFor(
  classification: Extract<TriggerClassification, { triggered: true }>,
  authorization: AuthorizationVerdict | undefined
): AdmissionAuthority | { refusal: AdmissionRefusal; reason: string } {
  if (classification.edge === 'machine') {
    return { via: 'continuation' }
  }

  const { actor, repo } = classification

  if (!authorization) {
    return {
      refusal: 'undetermined',
      reason:
        `Could not determine whether @${actor} may spend on ${repo}: the ` +
        'spend gate was never run. Admission refuses on uncertainty — a ' +
        'permission nobody asked about is not permission.'
    }
  }

  if (!authorization.authorized) {
    return { refusal: authorization.refusal, reason: authorization.reason }
  }

  return { via: 'permission', permission: authorization.permission }
}

function describeRuns(count: number): string {
  return count === 1 ? '1 run' : `${count} runs`
}
