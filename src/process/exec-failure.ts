/**
 * The shape `node:child_process` rejects with, narrowed once.
 *
 * A promisified `execFile` rejects with a plain `Error` decorated with the
 * child's exit code and its captured streams — and nothing in the type system
 * says so, so every shell that probes a subprocess has to narrow `unknown`
 * back to it by hand. Two were doing that independently (`probeSetup` and the
 * spend gate's `gh` probe), each with its own idea of what counts as present.
 * One narrowing, so a third shell inherits the same answer.
 */

export interface ExecFailure {
  /**
   * The child's exit code, or `undefined` when it never ran at all. That
   * distinction is load-bearing: no code means "the binary is not installed",
   * which is a different fact from "it ran and exited non-zero".
   */
  code: number | undefined
  stdout: string
  stderr: string
}

/**
 * Narrow a rejected `execFileAsync` to {@link ExecFailure}. Never throws and
 * never returns `undefined` fields other than `code` — an error that carries
 * nothing useful becomes empty streams, which every caller already handles.
 */
export function asExecFailure(error: unknown): ExecFailure {
  const failure =
    typeof error === 'object' && error !== null
      ? (error as { code?: unknown; stdout?: unknown; stderr?: unknown })
      : {}

  return {
    code: typeof failure.code === 'number' ? failure.code : undefined,
    stdout: typeof failure.stdout === 'string' ? failure.stdout : '',
    stderr: typeof failure.stderr === 'string' ? failure.stderr : ''
  }
}
