/**
 * The failure type every phase of an implement run throws, kept in its own
 * module so both the configuration seam and the orchestrator can throw it
 * without importing each other.
 */

import type { ClosureBlock } from '../guardrails/closure'
import type { RunUsage } from '../observability/usage'

export class ImplementAgentError extends Error {
  /** Bounded tail of the CLI's combined stdout/stderr, when available. */
  readonly outputTail?: string
  /**
   * What the run had spent when it failed, once it had spawned at all
   * (shopfloor#42). Undefined for a failure that refused before the spawn —
   * a precondition, a bad config — where the answer is genuinely nothing.
   *
   * It is on the error and not only on the run result because a failed run is
   * the one whose cost is least visible and most worth knowing: a guard kill,
   * a non-zero exit, and an exhausted attempt ceiling all spent real tokens and
   * all leave by throwing. A run result would report them; these never reach
   * one.
   */
  readonly usage?: RunUsage
  /**
   * True only when the inner loop spent its budget with the gate still red
   * (shopfloor#47). Carried as a flag rather than left to be read off the
   * message, because the issue state a run ends in turns on it: an exhausted
   * run means *the work is harder than the spec allowed for* and a failed one
   * means *something is broken*, and those are the two most different human
   * responses in the system. Matching prose to tell them apart is the rotted
   * binding this package keeps eliminating.
   */
  readonly exhausted: boolean
  /**
   * Set when the trajectory closure condition is what ended the run
   * (shopfloor#48): the gate was green and the *process* was not. Carried
   * whole rather than flattened into the message, so the shell that reports it
   * can name the violated invariants — and tell a violation apart from a
   * transcript it could not read — without matching on prose.
   */
  readonly closure?: ClosureBlock

  constructor(
    message: string,
    outputTail?: string,
    usage?: RunUsage,
    options: { exhausted?: boolean; closure?: ClosureBlock } = {}
  ) {
    super(message)
    this.name = 'ImplementAgentError'
    this.outputTail = outputTail
    this.usage = usage
    this.exhausted = options.exhausted ?? false
    this.closure = options.closure
  }
}
