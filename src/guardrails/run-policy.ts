/**
 * The run-policy contract a `runImplementAgent` caller may supply (ported from
 * recipe-chat-v1's `agent/implement/run-policy.ts`, #556, generalized away from
 * module-level constants into an explicit config object — see shopfloor#1 /
 * recipe-chat-v1#575). Every field is optional: an omitted field falls back to
 * {@link DEFAULT_RUN_POLICY}, so a caller states a run policy only where it
 * disagrees with the package's. The only names this package bakes in are the
 * two env-var-override keys below and the CLI's OAuth token requirement.
 */

import {
  DEFAULT_CLI_VERSION_STRICTNESS,
  type CliVersionStrictness
} from './cli-version'

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
   * Claude Code CLI version this run policy was validated against. The running
   * `claude --version` is compared against it before the spawn — see
   * `checkCliVersion` in `./cli-version` for the comparison rule, and
   * {@link RunPolicyConfig.cliVersionStrictness} for the consequence. Omitted
   * means the running version is recorded and compared to nothing.
   */
  cliVersion?: string
  /**
   * What a mismatch against {@link RunPolicyConfig.cliVersion} costs — warn
   * (the default), fail before spawning, or skip the check entirely.
   */
  cliVersionStrictness?: CliVersionStrictness
  /** Idle runaway budget, in minutes — overridable via {@link IDLE_MINUTES_ENV_VAR}. */
  idleMinutes?: number
  /**
   * Wall-clock runaway budget, in minutes — overridable via
   * {@link WALL_CLOCK_MINUTES_ENV_VAR}. Enforced: a run past this ceiling is
   * terminated and fails. Omitted leaves a run with no ceiling but the idle
   * guard, which a *looping* agent never trips.
   *
   * **This bounds the run, not one spawn.** A run that iterates (see
   * {@link RunPolicyConfig.gateCommand}) shares this budget across its spawns —
   * each one is armed with what is left of it — so N iterations can never cost
   * N times the ceiling. {@link RunPolicyConfig.idleMinutes} is the opposite,
   * and deliberately: silence is a property of one live process.
   */
  wallClockMinutes?: number
  /**
   * The consumer's quality gate — a shell command the **harness** runs after
   * each spawn, in the run's `cwd`, to decide whether the work is finished. A
   * non-zero exit feeds the command and a tail of its output back into a fresh
   * spawn, up to {@link RunPolicyConfig.maxIterations}.
   *
   * Omitted means a run is single-shot, exactly as every run was before the
   * inner loop existed: with no gate the harness has no signal of its own, and
   * the agent's own account of whether it passed is not one — that is the
   * failure the loop exists to catch. Caller-stated for the same reason
   * `requiredEnvVars` is: `bun run typecheck && bun run test` is this
   * consumer's vocabulary, not this package's.
   */
  gateCommand?: string
  /**
   * How many times a run may spawn the CLI, counting the first. Only reachable
   * with a {@link RunPolicyConfig.gateCommand} stated — without one there is
   * nothing to iterate on. A run whose gate is still failing when this is spent
   * **fails**; it does not return the unvetted work as a success.
   */
  maxIterations?: number
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
  maxIterations: number
  idleMinutes: number
  cliVersionStrictness: CliVersionStrictness
  requiredEnvVars: readonly string[]
}

/**
 * The policy a run gets when the caller states none. No model is named: an
 * absent model omits `--model` and lets the Claude CLI pick, rather than
 * pinning a string this package would have to keep current. No gate command is
 * named either, so a default run stays single-shot and only a caller who states
 * a gate opts into repeated spawns.
 */
export const DEFAULT_RUN_POLICY: ResolvedRunPolicy = {
  maxTurns: 150,
  // Reached only by a run that states a gate. Three is one spawn to do the
  // work and two to fix what the gate caught: a failure a fresh spawn cannot
  // fix twice over is usually a wrong approach rather than a near miss, and
  // spending a whole wall-clock budget rediscovering that is the expensive way
  // to find out.
  maxIterations: 3,
  idleMinutes: 15,
  cliVersionStrictness: DEFAULT_CLI_VERSION_STRICTNESS,
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
 * states one — which the guard reads as "this run has no ceiling", the one
 * budget with no package default, since a fabricated ceiling would kill runs
 * no caller ever asked to bound.
 */
export function resolveWallClockMs(
  config: Pick<RunPolicyConfig, 'wallClockMinutes'>,
  env: Record<string, string | undefined>
): number | undefined {
  const minutes =
    parsePositiveNumber(env[WALL_CLOCK_MINUTES_ENV_VAR]) ??
    config.wallClockMinutes
  return minutes === undefined ? undefined : minutes * 60_000
}
