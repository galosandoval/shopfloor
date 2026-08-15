/**
 * The failure type every phase of an implement run throws, kept in its own
 * module so both the configuration seam and the orchestrator can throw it
 * without importing each other.
 */

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

  constructor(message: string, outputTail?: string, usage?: RunUsage) {
    super(message)
    this.name = 'ImplementAgentError'
    this.outputTail = outputTail
    this.usage = usage
  }
}
