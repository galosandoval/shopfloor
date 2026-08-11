/**
 * The Claude CLI subprocess and the two runaway guards armed around it: an
 * idle guard watching for output silence, and a wall-clock guard watching
 * elapsed time (shopfloor#4). They catch different failure modes — a *stalled*
 * agent goes quiet, while a *looping* agent stays productive-looking and resets
 * the idle timer on every chunk — so a run needs both, and the caller learns
 * which one tripped from {@link SpawnClaudeResult.killedBy}.
 *
 * Its own module rather than a helper inside `implement.ts` because it is the
 * seam where a run stops being pure: everything above it is resolution and
 * verification, and this is the process. That also makes the guards testable
 * against a real child process instead of a mocked `spawn`.
 */

import { spawn } from 'node:child_process'
import { ImplementAgentError } from './implement-error'

/** Which runaway budget ended a run. */
export type KillReason = 'idle' | 'wall-clock'

/**
 * A run's termination by a guard: the budget that tripped, and the budget
 * itself. They travel together so no caller has to re-derive which of its
 * budgets a reason refers to — the value that did the killing is the value the
 * failure names.
 */
export interface RunawayKill {
  reason: KillReason
  /** The exceeded budget, in ms. */
  budgetMs: number
}

export interface SpawnClaudeResult {
  exitCode: number
  /** The guard that terminated the run, or null when it ended on its own. */
  killedBy: RunawayKill | null
  /** Bounded tail of the CLI's combined stdout/stderr, kept for failure diagnostics. */
  outputTail: string
}

export interface SpawnClaudeOptions {
  args: string[]
  prompt: string
  env: NodeJS.ProcessEnv
  cwd: string
  /** Output-silence budget in ms, always armed. */
  idleMs: number
  /** Elapsed-time budget in ms; undefined leaves the run without a ceiling. */
  wallClockMs?: number
  /** Called when the CLI never starts, so the run's transcript is still saved. */
  onSpawnError: () => void
  /** The binary to spawn — defaulted; stated only by tests, which stand a child process in for the CLI. */
  command?: string
  /** How often the guards check their budgets — defaulted; lowered by tests so they fire in milliseconds. */
  checkIntervalMs?: number
  /** {@link SIGTERM_GRACE_MS} for this run — defaulted; lowered by tests so escalation is observable. */
  sigtermGraceMs?: number
}

/** How much of the CLI's output to keep for a failure message. */
const TAIL_BYTES = 4_000

/**
 * One timer carries both budgets: at minute-scale ceilings the granularity is
 * irrelevant, and a second interval would buy nothing.
 */
const GUARD_CHECK_INTERVAL_MS = 15_000

/** How long a wall-clock kill waits between `SIGTERM` and `SIGKILL`. */
export const SIGTERM_GRACE_MS = 30_000

/** How each guard names itself and the overrun it reports. */
const GUARDS: Record<KillReason, { label: string; overran: string }> = {
  idle: { label: 'idle guard', overran: 'Agent idle for over' },
  'wall-clock': { label: 'wall-clock guard', overran: 'Agent ran for over' }
}

/**
 * Spawns the Claude CLI, piping its output to this process's own
 * stdout/stderr for the caller's job log while both runaway guards watch it.
 * Resolves with the run's exit code and which budget, if any, ended it; throws
 * {@link ImplementAgentError} only when the CLI never started.
 */
export async function spawnClaude(
  opts: SpawnClaudeOptions
): Promise<SpawnClaudeResult> {
  let outputTail = ''
  const captureTail = (chunk: Buffer) => {
    outputTail = (outputTail + chunk.toString('utf8')).slice(-TAIL_BYTES)
  }

  let killedBy: RunawayKill | null = null

  try {
    const exitCode = await new Promise<number>((resolve, reject) => {
      const child = spawn(opts.command ?? 'claude', [...opts.args, opts.prompt], {
        env: opts.env,
        cwd: opts.cwd
      })

      const startedAt = Date.now()
      let lastActivity = startedAt
      const onOutput = (stream: NodeJS.WriteStream) => (chunk: Buffer) => {
        stream.write(chunk)
        captureTail(chunk)
        lastActivity = Date.now()
      }
      child.stdout.on('data', onOutput(process.stdout))
      child.stderr.on('data', onOutput(process.stderr))

      let graceTimer: NodeJS.Timeout | undefined
      const guardTimer = setInterval(() => {
        const now = Date.now()
        const kill = trippedBudget(now - startedAt, now - lastActivity, opts)
        if (!kill) return

        // Stop watching before killing: the budget that tripped is the one the
        // failure names, and a child that takes a moment to die must neither
        // trip the other guard nor be signalled again on the next tick.
        killedBy = kill
        clearInterval(guardTimer)
        console.error(
          `\nFAILED: ${GUARDS[kill.reason].label} tripped after ${formatBudget(kill.budgetMs)} — killing the agent.`
        )
        graceTimer = terminate(child, kill.reason, opts.sigtermGraceMs)
      }, opts.checkIntervalMs ?? GUARD_CHECK_INTERVAL_MS)

      const stopTimers = () => {
        clearInterval(guardTimer)
        if (graceTimer) clearTimeout(graceTimer)
      }
      child.on('error', (error) => {
        stopTimers()
        reject(error)
      })
      child.on('close', (code) => {
        stopTimers()
        resolve(code ?? 1)
      })
    })
    return { exitCode, killedBy, outputTail }
  } catch (error) {
    opts.onSpawnError()
    throw new ImplementAgentError(
      `Failed to start the Claude CLI: ${String(error)}`
    )
  }
}

/** One sentence naming the budget a killed run exceeded, for a failure message. */
export function describeRunawayKill(kill: RunawayKill): string {
  const { label, overran } = GUARDS[kill.reason]
  return `${overran} ${formatBudget(kill.budgetMs)} — killed by the ${label}.`
}

/**
 * The budget a run has exceeded, or null while it is inside both. Wall-clock
 * is checked first so a run that blew its ceiling is reported as the runaway it
 * is, even if it also happens to have fallen silent since; the two can only
 * disagree when both trip inside the same check interval.
 *
 * @param elapsedMs - How long the run has been going.
 * @param idleForMs - How long since the run last said anything.
 */
function trippedBudget(
  elapsedMs: number,
  idleForMs: number,
  budgets: Pick<SpawnClaudeOptions, 'idleMs' | 'wallClockMs'>
): RunawayKill | null {
  const { idleMs, wallClockMs } = budgets
  if (wallClockMs !== undefined && elapsedMs > wallClockMs) {
    return { reason: 'wall-clock', budgetMs: wallClockMs }
  }
  if (idleForMs > idleMs) return { reason: 'idle', budgetMs: idleMs }
  return null
}

/**
 * Ends the run, and how depends on which budget tripped — a deliberate
 * asymmetry, not an oversight. A looping agent is far more likely than a
 * stalled one to hold real uncommitted work, so wall-clock sends `SIGTERM`
 * first and escalates only if the grace period passes. A stalled agent is
 * typically wedged somewhere that cannot service a signal handler at all, so
 * the idle guard skips a wait that would just delay the failure.
 *
 * @returns The pending escalation timer, for the caller to clear on close.
 */
function terminate(
  child: ReturnType<typeof spawn>,
  reason: KillReason,
  sigtermGraceMs = SIGTERM_GRACE_MS
): NodeJS.Timeout | undefined {
  if (reason === 'idle') {
    child.kill('SIGKILL')
    return undefined
  }

  child.kill('SIGTERM')
  const graceTimer = setTimeout(() => {
    console.error(
      `Agent did not exit within ${Math.round(sigtermGraceMs / 1000)}s of SIGTERM — sending SIGKILL.`
    )
    child.kill('SIGKILL')
  }, sigtermGraceMs)
  // The escalation must never be what keeps this process alive; the child's
  // own exit is.
  graceTimer.unref()
  return graceTimer
}

/**
 * A budget in the unit it reads best in. Budgets are stated in minutes, but an
 * override can be fractional, and rounding those to "0 minute(s)" would print a
 * ceiling the run demonstrably had.
 */
function formatBudget(budgetMs: number): string {
  if (budgetMs < 60_000) return `${Math.round(budgetMs / 1_000)} second(s)`
  return `${Math.round(budgetMs / 60_000)} minute(s)`
}
