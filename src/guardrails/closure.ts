/**
 * The closure condition (shopfloor#48, design review finding 1): given the
 * trajectory scorecard for the attempt that just finished, may this run close
 * as a success?
 *
 * **Why a gate and not another diagnostic.** With the outer loop's machine edge
 * firing on CI failure, the loop's definition of done is *CI is green* — and an
 * agent that deletes a failing test to get there exits as a success. The
 * trajectory checker could already prove that wrong and did nothing about it.
 * This is the half that acts: a run whose trajectory violates a **gating**
 * invariant does not reach the `succeeded` row. It re-enters the loop carrying
 * what it violated, or it lands `agent:blocked`.
 *
 * Pure, like every other decision here — the scorecard arrives already graded
 * (`runTrajectoryCheck` does the reading), and this returns a verdict the inner
 * loop acts on.
 */

import {
  DEFAULT_GATE_COMMAND_PATTERNS,
  type TrajectoryFinding,
  type TrajectoryInvariantId
} from '../observability/trajectory'

/**
 * The invariants that close a run, stated rather than inferred from the
 * scorecard — **not every finding is a gate**, and which ones are is the
 * decision this ticket exists to make.
 *
 * The two here are the implement phase's own contract: the quality gate ran
 * before each commit, and a failing test preceded the first one. Both describe
 * work the run claims to have done, and both are exactly what a test-deleting
 * shortcut to green violates.
 *
 * The other two stay advisory, each for its own reason.
 * `no-forbidden-git-ops` is already refused *at spawn time* by the command
 * guard, so a finding there reports on a guardrail that has acted — blocking on
 * it would be a second, later punishment for something that did not happen.
 * `turn-budget-headroom` is a capacity signal, not a process violation: a run
 * that nearly used its turn cap did nothing wrong, and gating on it would
 * block long work for being long.
 */
export const GATING_TRAJECTORY_INVARIANTS = [
  'gate-before-commit',
  'red-before-green'
] as const

export type GatingTrajectoryInvariantId =
  (typeof GATING_TRAJECTORY_INVARIANTS)[number]

export interface ClosureInput {
  /**
   * The scorecard for **the attempt that just ran**, or `null` when there was
   * nothing of that attempt's to grade — no transcript captured, or none
   * readable. Null is not a shorthand for an empty scorecard: it is the caller
   * saying the evidence is absent, which is a thing {@link evaluateClosure}
   * refuses on rather than a thing it grades.
   */
  findings: readonly TrajectoryFinding[] | null
  /**
   * Whether the run may spawn again: the inner loop's iteration budget and
   * wall clock, already asked (`checkIterationBudget`). A boolean rather than
   * the budgets themselves, because this decision is about the scorecard and
   * the loop's remaining room is a fact it is handed.
   */
  budgetRemaining: boolean
}

/**
 * What the run does about its own trajectory. `re-enter` is the only verdict
 * that spends more; both of the others end the run, one of them as a success.
 */
export type ClosureVerdict =
  | { kind: 'pass' }
  | {
      kind: 're-enter'
      violations: GatingTrajectoryInvariantId[]
      /** Appended to the next attempt's prompt — facts, never procedure. */
      feedback: string
    }
  | {
      kind: 'block'
      /**
       * Which of the two blocking cases this is, carried as a field rather
       * than left to be read off `reason`. A violated invariant and an
       * ungraded attempt are different things to go fix, and matching on prose
       * to tell them apart is the rotted binding this package keeps
       * eliminating.
       */
      cause: 'violation' | 'no-evidence'
      violations: GatingTrajectoryInvariantId[]
      reason: string
    }

/** The blocking half of a verdict — the only half that ends a run. */
export type ClosureBlock = Extract<ClosureVerdict, { kind: 'block' }>

/**
 * Whether this run may close as a success.
 *
 * **No evidence blocks.** A missing, empty, truncated, or malformed transcript
 * grades nothing, and this refuses it — the gate is satisfied by evidence that
 * the process held, never by the absence of evidence that it did not. Every
 * other guardrail in this package proceeds on an unreadable signal because a
 * missing *diagnostic* must not cause an outage; this one stopped being a
 * diagnostic the moment it became the success path's closure condition, and
 * the alternative is a gate anything can walk past by producing no transcript.
 * The cost is bounded and recoverable: the branch is pushed and the issue is
 * labelled for a human, which is the direction that costs least here.
 *
 * A no-evidence block never re-enters the loop even with budget left. Another
 * spawn corrects work a scorecard judged; it cannot conjure a transcript that
 * was never written, so re-entering would spend a full attempt to arrive at the
 * same verdict.
 */
export function evaluateClosure(input: ClosureInput): ClosureVerdict {
  const gating = (input.findings ?? []).filter(isGating)

  if (
    gating.length === 0 ||
    gating.every((f) => f.status === 'not-evaluable')
  ) {
    return {
      kind: 'block',
      cause: 'no-evidence',
      violations: [],
      reason:
        "This attempt's trajectory could not be graded — its session " +
        'transcript is missing, unreadable, or carries no turns — so there is ' +
        'no evidence that the quality gate ran before each commit or that a ' +
        'failing test preceded the first one. The closure condition is met by ' +
        'evidence that the process held, never by the absence of evidence that ' +
        'it did not, so the run does not close as a success.'
    }
  }

  const failed = gating.filter((finding) => finding.status === 'fail')
  if (failed.length === 0) return { kind: 'pass' }

  const violations = failed.map((finding) => finding.id)

  if (!input.budgetRemaining) {
    return {
      kind: 'block',
      cause: 'violation',
      violations,
      reason:
        'The run reached a passing gate on a trajectory that violates ' +
        `${violations.join(', ')}, and its budget for another attempt is ` +
        `spent:\n${describe(failed)}\n` +
        'A green gate reached this way is not a finished run — a human owns ' +
        'this one.'
    }
  }

  return { kind: 're-enter', violations, feedback: feedbackFor(failed) }
}

/**
 * The gate-run patterns the closure check grades against: the package defaults
 * plus, when the harness was given one, the consumer's own `gateCommand`
 * matched literally.
 *
 * Without this the gate fires falsely on every repository whose quality gate is
 * not a bare test command — `make check`, a bespoke script — because the agent
 * running exactly the command the harness runs would not be recognized as
 * running the gate. The harness knows that command; grading against anything
 * less is asking whether the agent ran *a* test suite when the question is
 * whether it ran *the* gate.
 *
 * The defaults are kept alongside rather than replaced: an agent that ran the
 * whole suite directly did verify its work, and refusing to notice would fail
 * in the expensive direction for no gain.
 */
export function resolveGatePatterns(
  gateCommand: string | undefined
): readonly RegExp[] {
  if (!gateCommand) return DEFAULT_GATE_COMMAND_PATTERNS
  return [
    ...DEFAULT_GATE_COMMAND_PATTERNS,
    new RegExp(escapeRegExp(gateCommand))
  ]
}

function escapeRegExp(literal: string): string {
  return literal.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function isGating(
  finding: TrajectoryFinding
): finding is TrajectoryFinding & { id: GatingTrajectoryInvariantId } {
  return (
    GATING_TRAJECTORY_INVARIANTS as readonly TrajectoryInvariantId[]
  ).includes(finding.id)
}

/** One line per violated invariant: its title, what the checker saw, and where. */
function describe(failed: readonly TrajectoryFinding[]): string {
  return failed
    .map((finding) => {
      const turns = finding.evidence
        .map((evidence) => `turn ${evidence.turnIndex}`)
        .join(', ')
      const where = turns ? ` (${turns})` : ''
      return `- **${finding.title}** (\`${finding.id}\`) — ${finding.detail}${where}`
    })
    .join('\n')
}

/**
 * What the next attempt is told. The same shape and the same restraint as the
 * gate's own feedback in `orchestration/iteration.ts`: **facts and one line of
 * contract, no procedure.** The harness may say what it observed in the
 * transcript and that the run is not finished until the trajectory is clean;
 * how to work test-first is the bundled skills plugin's, and a second copy here
 * would have no rule for which one wins.
 */
function feedbackFor(failed: readonly TrajectoryFinding[]): string {
  return [
    '',
    '## The previous attempt passed the gate on a trajectory that does not close',
    '',
    'The harness grades every run against process invariants read off its own ' +
      'session transcript. The last attempt violated:',
    '',
    describe(failed),
    '',
    'The gate passing is not on its own enough to finish this run — these ' +
      'invariants have to hold for the work as well.'
  ].join('\n')
}
