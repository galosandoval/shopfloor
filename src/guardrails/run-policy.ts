/**
 * The run-policy contract a `runImplementAgent` caller may supply (ported from
 * recipe-chat-v1's `agent/implement/run-policy.ts`, #556, generalized away from
 * module-level constants into an explicit config object — see shopfloor#1 /
 * recipe-chat-v1#575). Every field is optional: an omitted field falls back to
 * {@link DEFAULT_RUN_POLICY}, so a caller states a run policy only where it
 * disagrees with the package's. The only names this package bakes in are the
 * two env-var-override keys below and the CLI's OAuth token requirement.
 */

/** Env var that overrides {@link RunPolicyConfig.idleMinutes} for a single run. */
export const IDLE_MINUTES_ENV_VAR = 'LOCAL_IDLE_MINUTES'

/** Env var that overrides {@link RunPolicyConfig.wallClockMinutes} for a single run. */
export const WALL_CLOCK_MINUTES_ENV_VAR = 'LOCAL_WALL_CLOCK_MINUTES'

export interface RunPolicyConfig {
  /** Claude model the headless agent runs. Omitted means the Claude CLI's own default. */
  model?: string
  /** Fast-loop backstop cap on agent turns, layered on top of the guards below. */
  maxTurns?: number
  /**
   * Claude Code CLI version this run policy was validated against. Recorded
   * only — nothing compares a running CLI against it yet.
   */
  cliVersion?: string
  /** Idle runaway budget, in minutes — overridable via {@link IDLE_MINUTES_ENV_VAR}. */
  idleMinutes?: number
  /**
   * Wall-clock runaway budget, in minutes — overridable via
   * {@link WALL_CLOCK_MINUTES_ENV_VAR}. Recorded only: no guard enforces it
   * yet, so a run has no wall-clock ceiling regardless of this value.
   */
  wallClockMinutes?: number
  /**
   * Env vars the run needs, non-empty, before it spends any tokens — the
   * caller's own app-specific list (DB URLs, API keys, etc.). This package
   * bakes in no such names of its own, so it defaults to the empty list.
   */
  requiredEnvVars?: readonly string[]
}

/** A {@link RunPolicyConfig} with every defaultable field filled in. */
export interface ResolvedRunPolicy extends RunPolicyConfig {
  maxTurns: number
  idleMinutes: number
  requiredEnvVars: readonly string[]
}

/**
 * The policy a run gets when the caller states none. No model is named: an
 * absent model omits `--model` and lets the Claude CLI pick, rather than
 * pinning a string this package would have to keep current.
 */
export const DEFAULT_RUN_POLICY: ResolvedRunPolicy = {
  maxTurns: 150,
  idleMinutes: 15,
  requiredEnvVars: []
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

/**
 * An env var read as a positive number, or undefined when it is unset, empty,
 * non-numeric, or non-positive — every "the caller stated nothing usable" case
 * collapsing into one, so a bad override falls back instead of poisoning a
 * budget with `NaN`.
 */
export function parsePositiveNumber(
  raw: string | undefined
): number | undefined {
  const parsed = Number(raw)
  return raw && Number.isFinite(parsed) && parsed > 0 ? parsed : undefined
}

/**
 * Idle budget in ms — `config.idleMinutes` unless {@link IDLE_MINUTES_ENV_VAR}
 * overrides it, falling back to {@link DEFAULT_RUN_POLICY}'s budget.
 */
export function resolveIdleMs(
  config: Pick<RunPolicyConfig, 'idleMinutes'>,
  env: Record<string, string | undefined>
): number {
  const minutes =
    parsePositiveNumber(env[IDLE_MINUTES_ENV_VAR]) ??
    config.idleMinutes ??
    DEFAULT_RUN_POLICY.idleMinutes
  return minutes * 60_000
}

/**
 * Wall-clock budget in ms — `config.wallClockMinutes` unless
 * {@link WALL_CLOCK_MINUTES_ENV_VAR} overrides it, or undefined when neither
 * states one. Nothing enforces this yet; it is the value a future wall-clock
 * guard will read.
 */
export function resolveWallClockMs(
  config: Pick<RunPolicyConfig, 'wallClockMinutes'>,
  env: Record<string, string | undefined>
): number | undefined {
  const minutes =
    parsePositiveNumber(env[WALL_CLOCK_MINUTES_ENV_VAR]) ?? config.wallClockMinutes
  return minutes === undefined ? undefined : minutes * 60_000
}
