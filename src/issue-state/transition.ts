/**
 * The issue's state machine (shopfloor#45): given what an issue is labeled
 * with and what the run produced, what should it be labeled with next.
 *
 * Pure — no `gh`, no clock. {@link applyLabelTransition} is the shell that
 * reads the current labels and applies the delta. The split is the package's
 * usual one, and it earns its keep twice over here: the layer this replaces was
 * bash, where the transition was unreadable and untestable, and the reason this
 * design exists at all is a transition that silently never fired.
 *
 * **A table over outcomes, exhaustive rather than defaulting.** Every outcome
 * the harness can produce has exactly one row, and {@link TRANSITION_TABLE}'s
 * type makes a new outcome a compile error rather than a silent fall-through to
 * some default state. A state machine whose unhandled case is "leave the labels
 * as they are" is how an issue ends up stuck in `agent:in-progress` forever.
 *
 * **Each row is a target set, not a list of edits.** The edits are derived by
 * comparing the target against what the issue currently carries, which is what
 * makes applying a transition twice a no-op and makes a transition correct from
 * *any* starting state — including the ones a human left behind by editing
 * labels by hand mid-run.
 */

import { REQUIRED_LABELS } from './vocabulary'

/**
 * Every outcome the harness can produce, and the whole of it. `started` is the
 * one that is not terminal; the other four each end a run.
 *
 * `failed` and `exhausted` are deliberately not one outcome. A run that spent
 * its ceiling with the gate red and a run that crashed have the most different
 * human responses in the system — *the work is harder than specified* versus
 * *something is broken* — and collapsing them discards the most expensive
 * signal the harness produces.
 */
export const RUN_OUTCOMES = [
  'started',
  'succeeded',
  'exhausted',
  'failed',
  'refused'
] as const

export type RunOutcome = (typeof RUN_OUTCOMES)[number]

/**
 * The two ways a run that started can stop badly. Named here, beside the
 * vocabulary it narrows, because more than the transition table reads it: the
 * handoff artifact (shopfloor#49) is written on exactly these two endings and
 * on neither of the others. Defining it in either consumer would make the other
 * import across a layer it has no other business in.
 */
export type FailedPhaseOutcome = Extract<RunOutcome, 'failed' | 'exhausted'>

/**
 * One row: where the issue should end up. Why each outcome lands where it does
 * is a comment on the row rather than a field — nothing reads a rationale
 * string, and a value carried only so a test can assert it is non-empty is a
 * field with no consumer.
 */
export interface TransitionRow {
  /**
   * The vocabulary labels the issue should carry afterwards. Labels outside
   * the vocabulary are not mentioned because they are not this package's to
   * mention — see {@link evaluateLabelTransition}.
   */
  target: readonly string[]
}

/**
 * The table. `ready-for-human` gets an explicit entry on every terminal
 * outcome, which is the whole point of writing this down: the design document
 * exists because that swap had never once fired, and no section said what made
 * it fire. Inference is how the bash layer got here, so the rule is stated —
 * **`ready-for-human` is set by any outcome that ends the run, whatever the
 * run produced.** It marks whose move it is, not whether the work is good; a
 * blocked issue and a finished one both need a human next, and only the
 * `agent:` labels distinguish which kind of attention.
 */
export const TRANSITION_TABLE: Record<RunOutcome, TransitionRow> = {
  // A run is in flight: the phase that owns the issue is named, and the
  // process label that admitted it is spent.
  started: { target: ['agent:implement', 'agent:in-progress'] },
  // The agent is done and a human owns the next move.
  succeeded: { target: ['ready-for-human'] },
  // The run spent its ceiling with the gate still red — the work is harder
  // than the spec allowed for, or the spec is wrong.
  exhausted: { target: ['agent:exhausted', 'ready-for-human'] },
  // The run could not finish, and a human must unblock it.
  failed: { target: ['agent:blocked', 'ready-for-human'] },
  // The run refused before starting, and a human must unblock it. Note that
  // ENTRY_LABEL is dropped here as well as `agent:implement`: GitHub fires
  // `issues.labeled` only when a label is *added*, so leaving it on would make
  // re-adding it a no-op and the retry unreachable.
  refused: { target: ['agent:blocked', 'ready-for-human'] }
}

export interface LabelTransitionInput {
  /** Every label the issue carries now, vocabulary and consumer alike. */
  currentLabels: readonly string[]
  outcome: RunOutcome
}

/** The edits that take the issue from where it is to where the table says. */
export interface LabelTransition {
  outcome: RunOutcome
  add: string[]
  remove: string[]
}

/**
 * The delta between what the issue carries and what {@link TRANSITION_TABLE}
 * says this outcome should leave it carrying.
 *
 * **Only vocabulary labels are ever removed.** A consumer's own labels — `bug`,
 * a milestone tag, whatever their triage runs on — are outside what this
 * package owns, and a state machine that cleared them would be reaching into a
 * shared human workspace to enforce a model of state it does not have. The
 * target set is therefore a statement about six names and silent about every
 * other.
 *
 * Both lists come back empty when the issue is already where it should be,
 * which is what lets the shell skip the write entirely.
 */
export function evaluateLabelTransition(
  input: LabelTransitionInput
): LabelTransition {
  const { target } = TRANSITION_TABLE[input.outcome]
  const current = new Set(input.currentLabels)

  return {
    outcome: input.outcome,
    add: target.filter((label) => !current.has(label)),
    remove: REQUIRED_LABELS.filter(
      (label) => current.has(label) && !target.includes(label)
    )
  }
}
