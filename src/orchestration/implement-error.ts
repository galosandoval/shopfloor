/**
 * The failure type every phase of an implement run throws, kept in its own
 * module so both the configuration seam and the orchestrator can throw it
 * without importing each other.
 */
export class ImplementAgentError extends Error {
  /** Bounded tail of the CLI's combined stdout/stderr, when available. */
  readonly outputTail?: string

  constructor(message: string, outputTail?: string) {
    super(message)
    this.name = 'ImplementAgentError'
    this.outputTail = outputTail
  }
}
