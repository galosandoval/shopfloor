/**
 * The run-policy contract every `runImplementAgent` caller supplies (ported
 * from recipe-chat-v1's `agent/implement/run-policy.ts`, #556, generalized
 * away from module-level constants into an explicit config object — see
 * shopfloor#1 / recipe-chat-v1#575). Model, turn cap, CLI version, and the
 * runaway-guard budgets are the caller's choice; the only names this package
 * bakes in are the two env-var-override keys below and the CLI's OAuth token
 * requirement.
 */

/** Env var that overrides {@link RunPolicyConfig.idleMinutes} for a single run. */
export const IDLE_MINUTES_ENV_VAR = 'LOCAL_IDLE_MINUTES'

/** Env var that overrides {@link RunPolicyConfig.wallClockMinutes} for a single run. */
export const WALL_CLOCK_MINUTES_ENV_VAR = 'LOCAL_WALL_CLOCK_MINUTES'

export interface RunPolicyConfig {
  /** Claude model the headless agent runs. */
  model: string
  /** Fast-loop backstop cap on agent turns, layered on top of the guards below. */
  maxTurns: number
  /** Pinned Claude Code CLI version this run policy was validated against. */
  cliVersion: string
  /** Idle runaway budget, in minutes — overridable via {@link IDLE_MINUTES_ENV_VAR}. */
  idleMinutes: number
  /** Wall-clock runaway budget, in minutes — overridable via {@link WALL_CLOCK_MINUTES_ENV_VAR}. */
  wallClockMinutes: number
  /**
   * Env vars the run needs, non-empty, before it spends any tokens — the
   * caller's own app-specific list (DB URLs, API keys, etc.). This package
   * bakes in no such names of its own.
   */
  requiredEnvVars: readonly string[]
}

/**
 * Names of `requiredEnvVars` that are absent or empty in `env`, in the order
 * given. An empty array means the run may proceed.
 */
export function findMissingEnvVars(
  requiredEnvVars: readonly string[],
  env: Record<string, string | undefined>
): string[] {
  return requiredEnvVars.filter((name) => !env[name])
}

/** Parse a minutes override, falling back to `fallbackMinutes` unless it is a positive number. */
function resolveMinutesMs(
  raw: string | undefined,
  fallbackMinutes: number
): number {
  const parsed = Number(raw)
  const minutes =
    Number.isFinite(parsed) && parsed > 0 ? parsed : fallbackMinutes
  return minutes * 60_000
}

/** Idle budget in ms — `config.idleMinutes` unless {@link IDLE_MINUTES_ENV_VAR} overrides it. */
export function resolveIdleMs(
  config: Pick<RunPolicyConfig, 'idleMinutes'>,
  env: Record<string, string | undefined>
): number {
  return resolveMinutesMs(env[IDLE_MINUTES_ENV_VAR], config.idleMinutes)
}

/** Wall-clock budget in ms — `config.wallClockMinutes` unless {@link WALL_CLOCK_MINUTES_ENV_VAR} overrides it. */
export function resolveWallClockMs(
  config: Pick<RunPolicyConfig, 'wallClockMinutes'>,
  env: Record<string, string | undefined>
): number {
  return resolveMinutesMs(env[WALL_CLOCK_MINUTES_ENV_VAR], config.wallClockMinutes)
}
