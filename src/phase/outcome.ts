/**
 * What a finished phase leaves the issue in (shopfloor#47): the one decision
 * between a run ending and the state machine being told about it.
 *
 * Pure — the shell around it (`run-phase.ts`) catches what the run threw and
 * applies whatever this returns through the transition table (shopfloor#45).
 * It is small on purpose and separate anyway, because it is the point where
 * two failures that look identical to a `catch` become the two most different
 * human responses in the system: *the work is harder than specified* and
 * *something is broken*.
 */

import type { FailedPhaseOutcome, RunOutcome } from '../issue-state/transition'

/** How a phase's run ended, as the shell saw it. */
export type PhaseEnding =
  | { failed: false }
  /**
   * The run threw. `exhausted` is the inner loop's own verdict
   * (`evaluateIteration`), carried out on {@link ImplementAgentError} rather
   * than re-derived from the message: a run that spent its ceiling with the
   * gate still red is a different state from one that crashed, and matching on
   * prose to tell them apart is the rotted binding this package keeps
   * eliminating.
   */
  | { failed: true; exhausted: boolean }

/**
 * The transition-table outcome for an ending. `started` and `refused` are
 * deliberately unreachable from here — the first is applied before the run and
 * the second by the guards that refuse it, so an ending only ever names one of
 * the three ways a run that actually started can stop.
 */
export function evaluatePhaseOutcome(ending: {
  failed: true
  exhausted: boolean
}): FailedPhaseOutcome
export function evaluatePhaseOutcome(ending: PhaseEnding): RunOutcome
export function evaluatePhaseOutcome(ending: PhaseEnding): RunOutcome {
  if (!ending.failed) return 'succeeded'
  return ending.exhausted ? 'exhausted' : 'failed'
}
