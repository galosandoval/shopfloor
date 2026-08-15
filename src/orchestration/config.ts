/**
 * The configuration contract for an implement run, and the pure function that
 * resolves it (shopfloor#1). A caller states an issue number and a prompt;
 * everything else resolves in one documented order — explicit input, then
 * environment variable, then (for the few fields a subprocess can answer) a
 * probe run by `runImplementAgent`, then a package default.
 *
 * No IO happens here: the environment arrives as a parameter, matching
 * `findMissingEnvVars(required, env)`, so the whole configuration contract is
 * testable without touching disk, env, or network. Fields a probe answers come
 * back undefined rather than guessed.
 */

import * as os from 'node:os'
import * as path from 'node:path'
import { parseCliVersionStrictness } from '../guardrails/cli-version'
import {
  DEFAULT_RUN_POLICY,
  parsePositiveNumber,
  type ResolvedRunPolicy,
  type RunPolicyConfig
} from '../guardrails/run-policy'
import { ImplementAgentError } from './implement-error'

/** Everything a caller may state about a run; see the module doc for how each field resolves. */
export interface RunImplementAgentConfig {
  /** Defaults to `ISSUE_NUMBER`; a run cannot resolve without one. */
  issueNumber?: string
  /** Defaults to `ISSUE_TITLE`, else fetched from the issue itself via `gh`. */
  issueTitle?: string
  /** Defaults to `BRANCH`, then `GITHUB_REF_NAME`, then the current git checkout. */
  branch?: string
  /** `owner/repo` — defaults to `GITHUB_REPOSITORY`, else the current checkout's remote. */
  repo?: string
  /**
   * Subscription / flat-rate token — never `ANTHROPIC_API_KEY` (metered).
   * Defaults to `CLAUDE_CODE_OAUTH_TOKEN`.
   */
  claudeCodeOAuthToken?: string
  /** Raw contents of the prompt template, with `{{PLACEHOLDER}}` tokens to render. */
  promptTemplate: string
  /**
   * Claude Code plugin directories (or `.zip` archives) loaded into this
   * session only, one `--plugin-dir` each, so their skills reach the agent
   * without anything being written into the consumer's git tree. Defaults to
   * `PLUGIN_DIRS`, comma-separated; unstated by both, the run falls back to
   * the bundled plugin — a stated list **replaces** that default rather than
   * adding to it, and a stated empty one loads nothing at all. The fallback
   * itself is `resolveBundledPluginDir`, in the shell, because locating it is
   * filesystem work.
   *
   * Named for what it grants rather than for skills, the reason it is wanted:
   * a plugin can carry more than skills, so a name promising "skills" would
   * let one quietly widen a run's surface while reading as inert. Every entry
   * is validated before the spawn by `evaluatePluginDirs`. Remote
   * plugin URLs are deliberately not accepted: fetching unattested code over
   * the network into a fully-permissioned autonomous run is its own decision.
   */
  pluginDirs?: string[]
  /**
   * Directory the run's outputs are written beneath — defaults to `OUTPUT_DIR`,
   * else the OS temp dir. Each derived path below can still be set on its own.
   */
  outputDir?: string
  /** Path the agent writes its PR description to; a fallback is written here if empty. */
  prDescriptionFile?: string
  /** Path the agent writes its verify-phase report to. */
  verifyReportFile?: string
  /** Where to copy the agent's Claude Code session transcript for audit. */
  transcriptFile?: string
  /** Where a caller's CI glue writes the reason a failed run gave. */
  failureReasonFile?: string
  /**
   * Repo-relative dir the agent commits verify-phase screenshots into —
   * defaults to `SCREENSHOTS_DIR`, else an issue-scoped path. Deliberately not
   * derived from `outputDir`: these files get committed, so they belong in the
   * repo rather than in a temp dir.
   */
  screenshotsDir?: string
  /** Claude Code's session store — defaults to `PROJECTS_DIR`, else `$HOME/.claude/projects`. */
  projectsDir?: string
  /** Stated field-by-field; anything omitted falls back to {@link DEFAULT_RUN_POLICY}. */
  runPolicy?: RunPolicyConfig
  /** Defaults to `process.env`. */
  env?: NodeJS.ProcessEnv
  /** Defaults to `process.cwd()` — where the CLI spawns and `git rev-list` runs. */
  cwd?: string
}

/**
 * A {@link RunImplementAgentConfig} with every field this function can settle
 * settled. `branch`, `repo`, `issueTitle`, and `cwd` stay optional — they are
 * what the IO shell answers with a `git` / `gh` probe or `process.cwd()`,
 * which this function does not do.
 */
export interface ResolvedImplementConfig {
  issueNumber: string
  issueTitle?: string
  branch?: string
  repo?: string
  claudeCodeOAuthToken: string
  promptTemplate: string
  /**
   * Omitted entirely when nothing stated a list, so "unstated" stays
   * distinguishable from "stated as empty" — the first falls back to the
   * bundled plugin and the second loads none, and a fabricated `[]` here would
   * erase the difference.
   */
  pluginDirs?: string[]
  prDescriptionFile: string
  verifyReportFile: string
  transcriptFile: string
  failureReasonFile: string
  screenshotsDir: string
  projectsDir: string
  runPolicy: ResolvedRunPolicy
  cwd?: string
}

/**
 * Resolve a caller's partial config against `env` into the full set of values
 * a run needs. Total and pure — the only failures are a run that cannot be
 * identified (no issue number) or authenticated (no OAuth token), both of
 * which throw {@link ImplementAgentError} naming the variable to set.
 */
export function resolveImplementConfig(
  input: RunImplementAgentConfig,
  env: Record<string, string | undefined>
): ResolvedImplementConfig {
  // First, so a caller carrying the removed field hears about the removal
  // rather than about whatever it made them get wrong downstream.
  requireNoStandardsDir(input, env)

  const issueNumber = input.issueNumber ?? env.ISSUE_NUMBER
  if (!issueNumber) {
    throw new ImplementAgentError(
      'No issue number to implement — pass `issueNumber` or set ISSUE_NUMBER.'
    )
  }

  const claudeCodeOAuthToken =
    input.claudeCodeOAuthToken ?? env.CLAUDE_CODE_OAUTH_TOKEN
  if (!claudeCodeOAuthToken) {
    throw new ImplementAgentError(
      'No Claude Code OAuth token — pass `claudeCodeOAuthToken` or set CLAUDE_CODE_OAUTH_TOKEN.'
    )
  }

  const inOutputDir = (file: string) =>
    path.join(resolveOutputDir(input, env), file)

  const resolved: ResolvedImplementConfig = {
    issueNumber,
    issueTitle: input.issueTitle ?? env.ISSUE_TITLE,
    branch: input.branch ?? env.BRANCH ?? env.GITHUB_REF_NAME,
    repo: input.repo ?? env.GITHUB_REPOSITORY,
    claudeCodeOAuthToken,
    promptTemplate: input.promptTemplate,
    prDescriptionFile:
      input.prDescriptionFile ?? inOutputDir('pr_description.txt'),
    verifyReportFile: input.verifyReportFile ?? inOutputDir('verify_report.md'),
    transcriptFile: input.transcriptFile ?? inOutputDir('transcript.jsonl'),
    failureReasonFile:
      input.failureReasonFile ?? inOutputDir(FAILURE_REASON_FILE),
    screenshotsDir:
      input.screenshotsDir ??
      env.SCREENSHOTS_DIR ??
      `.agent/verify/issue-${issueNumber}`,
    projectsDir:
      input.projectsDir ??
      env.PROJECTS_DIR ??
      path.join(os.homedir(), '.claude', 'projects'),
    runPolicy: resolveRunPolicy(input.runPolicy ?? {}, env),
    cwd: input.cwd
  }

  // Omitted rather than defaulted, so an unstated list stays distinct from one
  // stated as empty — `PLUGIN_DIRS=''` is a caller saying "no plugins at all".
  const pluginDirs = input.pluginDirs ?? parseNameList(env.PLUGIN_DIRS)
  if (pluginDirs !== undefined) resolved.pluginDirs = pluginDirs

  return resolved
}

/**
 * Refuse a run still configured for `standardsDir` / `STANDARDS_DIR`, removed
 * in shopfloor#27 — skills reach the agent through the CLI's own plugin
 * discovery now, so a directory path pasted into a prompt has nothing left to
 * mean.
 *
 * **The field is gone from {@link RunImplementAgentConfig} and still read
 * here, deliberately.** Do not tidy this away as dead code: the type removal
 * only reaches a caller who type-checks against this package, and the failure
 * this migration exists to prevent is a consumer's CI that sets the
 * environment variable — where a plain deletion produces no type error, no
 * runtime error, and a run that proceeds with less context than its operator
 * believes it has. That is the silent degradation the validation one release
 * ago was added to stop, and deleting the field carelessly would reintroduce
 * it in a form no one would notice.
 *
 * Either source refuses on its own rather than one taking precedence over the
 * other: a stated value is not a way to mask a set variable, and precedence
 * logic whose only purpose is to be deleted later is what a deprecation window
 * would have cost. An empty value from either still means "deliberately skip",
 * as it always has, and does not refuse.
 */
function requireNoStandardsDir(
  input: RunImplementAgentConfig,
  env: Record<string, string | undefined>
): void {
  const stated = (input as { standardsDir?: unknown }).standardsDir
  if (!stated && !env.STANDARDS_DIR) return

  throw new ImplementAgentError(
    '`standardsDir` / STANDARDS_DIR has been removed — skills now reach the ' +
      "agent through Claude Code's own plugin discovery, not through a path " +
      'substituted into the prompt. Unset it; an unstated `pluginDirs` / ' +
      'PLUGIN_DIRS loads the bundled skills plugin, and a stated one replaces ' +
      'that. Coding standards belong in the repository being worked on.'
  )
}

/** Name of the file a failed run's reason is written to, beneath the output dir. */
export const FAILURE_REASON_FILE = 'failure_reason.txt'

/**
 * Where the run's outputs go — the one derivation the CLI shares, so a run
 * that fails *before* its config resolves can still find the same directory to
 * write its failure reason into.
 */
export function resolveOutputDir(
  input: Pick<RunImplementAgentConfig, 'outputDir'>,
  env: Record<string, string | undefined>
): string {
  return input.outputDir ?? env.OUTPUT_DIR ?? os.tmpdir()
}

/** Merge a stated policy over the environment's, then over {@link DEFAULT_RUN_POLICY}. */
function resolveRunPolicy(
  stated: RunPolicyConfig,
  env: Record<string, string | undefined>
): ResolvedRunPolicy {
  const resolved: ResolvedRunPolicy = {
    model: stated.model ?? env.MODEL ?? DEFAULT_RUN_POLICY.model,
    maxTurns:
      stated.maxTurns ??
      parsePositiveNumber(env.MAX_TURNS) ??
      DEFAULT_RUN_POLICY.maxTurns,
    maxIterations:
      stated.maxIterations ??
      parsePositiveNumber(env.MAX_ITERATIONS) ??
      DEFAULT_RUN_POLICY.maxIterations,
    idleMinutes:
      stated.idleMinutes ??
      parsePositiveNumber(env.IDLE_MINUTES) ??
      DEFAULT_RUN_POLICY.idleMinutes,
    cliVersionStrictness:
      stated.cliVersionStrictness ??
      // An unrecognized level falls back rather than throwing: this setting
      // decides how loudly a *diagnostic* speaks, and refusing a run over a
      // typo in it would be louder than the check it configures.
      parseCliVersionStrictness(env.CLI_VERSION_STRICTNESS) ??
      DEFAULT_RUN_POLICY.cliVersionStrictness,
    requiredEnvVars:
      stated.requiredEnvVars ??
      parseNameList(env.REQUIRED_ENV_VARS) ??
      DEFAULT_RUN_POLICY.requiredEnvVars
  }

  // Recorded, not enforced — omitted entirely rather than defaulted, so an
  // absent budget reads as "no ceiling stated" instead of a fabricated one.
  const cliVersion = stated.cliVersion ?? env.CLI_VERSION
  if (cliVersion !== undefined) resolved.cliVersion = cliVersion

  const wallClockMinutes =
    stated.wallClockMinutes ?? parsePositiveNumber(env.WALL_CLOCK_MINUTES)
  if (wallClockMinutes !== undefined)
    resolved.wallClockMinutes = wallClockMinutes

  // Omitted rather than defaulted for the same reason: an absent gate is a
  // single-shot run, and a fabricated one would be a command this package
  // invented running in the consumer's checkout. An empty string reads as
  // unstated — a caller unsetting the variable is not asking to run `''`.
  const gateCommand = stated.gateCommand ?? env.GATE_COMMAND
  if (gateCommand) resolved.gateCommand = gateCommand

  return resolved
}

/** A comma-separated env-var list, or undefined when the variable is unset. */
function parseNameList(raw: string | undefined): string[] | undefined {
  if (raw === undefined) return undefined
  return raw
    .split(',')
    .map((name) => name.trim())
    .filter(Boolean)
}
