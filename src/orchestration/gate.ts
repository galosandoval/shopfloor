/**
 * Running the consumer's quality gate — the inner loop's signal (shopfloor#40).
 * The IO half of {@link evaluateIteration}: it executes a command and reports
 * what happened, and decides nothing.
 *
 * The command is stated by the caller (`runPolicy.gateCommand`) and run through
 * a shell, because a gate is normally a chain (`bun run typecheck && bun run
 * test`) and this package ships no build-tool vocabulary of its own. That is
 * the same trust boundary `requiredEnvVars` sits on: the string comes from the
 * consumer's own configuration, never from the issue, the agent, or anything
 * the run reads.
 */

import { spawnSync } from 'node:child_process'
import type { GateResult } from './iteration'

/** How much of the gate's output to keep for the next turn's feedback. */
const TAIL_BYTES = 4_000

interface RunGateOptions {
  cwd: string
  /**
   * The run's own environment, deliberately **not** the CLI's child env. The
   * OAuth token and the stripped `ANTHROPIC_API_KEY` keep the *agent* off a
   * metered key; the gate is not the agent, and the consumer's test suite needs
   * the environment its own tooling expects — with no credential it never asked
   * for pushed into it.
   */
  env: NodeJS.ProcessEnv
}

/**
 * Runs `command` and reports whether it passed, with a bounded tail of its
 * combined output. A command that cannot be run at all counts as a failure like
 * any other: the run has no evidence the work is good, which is what the gate
 * is being asked, and the tail says what went wrong.
 */
export function runGate(command: string, opts: RunGateOptions): GateResult {
  const result = spawnSync(command, {
    shell: true,
    cwd: opts.cwd,
    env: opts.env,
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024
  })

  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`
  const outputTail = (
    result.error ? `${output}\n${String(result.error)}` : output
  ).slice(-TAIL_BYTES)

  return {
    command,
    passed: !result.error && result.status === 0,
    outputTail
  }
}
