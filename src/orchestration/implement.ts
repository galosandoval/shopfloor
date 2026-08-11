/**
 * Orchestrator for a single "implement this issue" agent run (ported from
 * recipe-chat-v1's `agent/implement/implement.ts`, #510/#540/#556). Spawns
 * the Claude Code CLI directly and owns the run's runaway budgets — an idle
 * timeout and a wall-clock ceiling, both enforced in {@link spawnClaude} — plus
 * a zero-commit failure check. It is also
 * the IO shell around the pure {@link resolveImplementConfig}: the `git` and
 * `gh` probes that answer what neither the caller nor the environment stated
 * live here. The caller owns everything outside the run itself — checking out
 * the branch, opening the PR, sandboxing (an ephemeral CI runner or a
 * container).
 */

import * as fs from 'node:fs'
import * as path from 'node:path'
import { execFileSync, execSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { captureTranscript } from '../observability/transcript'
import { prepareClaudeInvocation } from './claude-invocation'
import { describeRunawayKill, spawnClaude } from './spawn-claude'
import {
  findMissingEnvVars,
  resolveIdleMs,
  resolveWallClockMs,
  type ResolvedRunPolicy
} from '../guardrails/run-policy'
import { checkCliVersion, parseCliVersion } from '../guardrails/cli-version'
import { ImplementAgentError } from './implement-error'
import {
  resolveImplementConfig,
  type ResolvedImplementConfig,
  type RunImplementAgentConfig
} from './config'

export interface RunImplementAgentResult {
  /** The branch the run committed on, as resolved — stated, inferred, or probed. */
  branch: string
  /** Commits made on `branch` since `main`, per `git rev-list --count`. */
  commitsAhead: number
  transcriptCaptured: boolean
  /** Whether the agent wrote its own PR description, or this run fell back to one. */
  prDescription: 'agent' | 'fallback'
  /**
   * The Claude Code CLI version this run actually spawned, per `claude
   * --version`. Undefined when that probe failed or said something
   * unrecognized — recorded so a run's output names which CLI produced it,
   * independently of whether a pin was stated to compare against.
   */
  cliVersion?: string
}

/**
 * Runs the agent once: resolves the caller's configuration (filling anything
 * unstated from the environment, a `git` / `gh` probe, or a package default),
 * settles every pre-spawn precondition (see {@link verifyPreconditions}),
 * spawns the Claude Code CLI with both runaway guards armed, captures the session transcript, and
 * verifies the run actually committed. Throws {@link ImplementAgentError} on
 * any failure — callers own translating that into their own CI-glue (writing a
 * failure-reason file, exiting non-zero).
 */
export async function runImplementAgent(
  input: RunImplementAgentConfig
): Promise<RunImplementAgentResult> {
  const env = input.env ?? process.env
  const config = resolveImplementConfig(input, env)
  const cwd = config.cwd ?? process.cwd()

  const cliVersion = verifyPreconditions(config, env, cwd)

  const branch = config.branch ?? probeBranch(cwd)
  const issueTitle =
    config.issueTitle ?? probeIssueTitle(config.issueNumber, config.repo, cwd)

  const { args, prompt } = prepareClaudeInvocation({
    promptTemplate: config.promptTemplate,
    issueNumber: config.issueNumber,
    issueTitle,
    branch,
    prDescriptionFile: config.prDescriptionFile,
    standardsDir: config.standardsDir,
    verifyReportFile: config.verifyReportFile,
    screenshotsDir: config.screenshotsDir,
    model: config.runPolicy.model,
    maxTurns: config.runPolicy.maxTurns,
    commandGuardHookPath: resolveCommandGuardHookPath(),
    // Always stream: the idle guard below watches the CLI's output for a
    // heartbeat, and `--print` text stays silent until the session ends.
    streamOutput: true
  })

  // Never let the child fall through to a metered API key, even if the
  // invoking environment happens to have one set — auth must be OAuth-only.
  const childEnv = {
    ...env,
    CLAUDE_CODE_OAUTH_TOKEN: config.claudeCodeOAuthToken
  }
  delete (childEnv as Record<string, unknown>).ANTHROPIC_API_KEY

  const idleMs = resolveIdleMs(config.runPolicy, env)
  const wallClockMs = resolveWallClockMs(config.runPolicy, env)
  const captureRunTranscript = () =>
    captureTranscript({
      projectsDir: config.projectsDir,
      destPath: config.transcriptFile
    })

  const { exitCode, killedBy, outputTail } = await spawnClaude({
    args,
    prompt,
    env: childEnv,
    cwd,
    idleMs,
    wallClockMs,
    onSpawnError: captureRunTranscript
  })

  // Copy the agent's session transcript out for the caller to upload as an
  // audit artifact. Best-effort; there's exactly one session per run, so the
  // newest-JSONL scan inside captureTranscript resolves it unambiguously.
  const transcriptCaptured = captureRunTranscript()

  // A killed run fails before the commit check below, and deliberately stays
  // that way for the wall-clock guard too: a run cut off mid-loop never
  // reached its own verify phase, so whatever it committed is unvetted
  // work-in-progress. That is why this doesn't follow the leniency the missing
  // PR description gets further down — there, the commits were finished and
  // only the prose was absent.
  if (killedBy) {
    throw new ImplementAgentError(describeRunawayKill(killedBy), outputTail)
  }

  if (exitCode !== 0) {
    throw new ImplementAgentError(
      `Claude CLI exited with status ${exitCode}.`,
      outputTail
    )
  }

  // The agent commits its own TDD work; a zero-commit run is a failure, not a PR.
  const commitsAhead = Number(
    execSync('git rev-list --count main..HEAD', {
      encoding: 'utf8',
      cwd
    }).trim()
  )
  if (!Number.isFinite(commitsAhead) || commitsAhead === 0) {
    throw new ImplementAgentError(
      'Agent finished but made no commits on the branch.'
    )
  }

  // Without a description the PR body would be just `Closes #N`. Fall back
  // rather than discard otherwise-green commits.
  let prDescription: RunImplementAgentResult['prDescription'] = 'agent'
  if (!fileHasContent(config.prDescriptionFile)) {
    prDescription = 'fallback'
    fs.writeFileSync(
      config.prDescriptionFile,
      `Implements #${config.issueNumber}: ${issueTitle}\n`
    )
  }

  return { branch, commitsAhead, transcriptCaptured, prDescription, cliVersion }
}

/**
 * Everything that must hold before the CLI spawns, so a misconfigured run
 * fails immediately instead of spending tokens on a doomed one: the caller's
 * required env vars, the standards path, and the CLI version. Returns the
 * running CLI version for the run result — the one thing these checks produce
 * rather than merely permit.
 *
 * They differ in how hard they push back, and each difference is deliberate: a
 * missing env var or a dead standards path is a misconfiguration that changes
 * what the run produces, while a drifted CLI is a diagnostic that only
 * sometimes matters. See {@link requireStandardsDir} and `checkCliVersion`.
 */
function verifyPreconditions(
  config: ResolvedImplementConfig,
  env: Record<string, string | undefined>,
  cwd: string
): string | undefined {
  // Validate the whole contract-required env up front, so a missing var fails
  // immediately naming every offender.
  const missingEnv = findMissingEnvVars(config.runPolicy.requiredEnvVars, env)
  if (missingEnv.length > 0) {
    throw new ImplementAgentError(
      `Missing required env var(s): ${missingEnv.join(', ')}`
    )
  }

  requireStandardsDir(config.standardsDir, cwd)
  return checkRunningCliVersion(config.runPolicy, cwd)
}

/**
 * Refuse a non-empty `standardsDir` that resolves to nothing, naming the path.
 * An empty one still means "deliberately skip", unchanged — the prompt
 * template's own text handles that. This is stricter than the CLI-version
 * warn on purpose: a wrong path is indistinguishable from a right one in the
 * rendered prompt, so the run quietly instructs the agent to read nothing and
 * produces work against no standards at all.
 */
function requireStandardsDir(standardsDir: string, cwd: string): void {
  if (!standardsDir) return

  let isDirectory = false
  try {
    // Resolved against the run's cwd, which is where the agent itself reads
    // the path from: a relative `standardsDir` validated against this
    // process's cwd would pass or fail on the wrong directory entirely.
    isDirectory = fs.statSync(path.resolve(cwd, standardsDir)).isDirectory()
  } catch {
    // Unreadable and absent are the same misconfiguration to a run.
  }
  if (isDirectory) return

  throw new ImplementAgentError(
    `Standards directory does not resolve to a directory: ${standardsDir} — ` +
      'point `standardsDir` / STANDARDS_DIR at a directory that exists, or ' +
      'leave it unset to skip the standards step deliberately.'
  )
}

/**
 * The running CLI version, having compared it against the policy's pin. Throws
 * only under `'error'` strictness; the default warns and lets the run proceed.
 * Returns the version for the run result either way, including when no pin was
 * stated to compare against.
 */
function checkRunningCliVersion(
  runPolicy: Pick<ResolvedRunPolicy, 'cliVersion' | 'cliVersionStrictness'>,
  cwd: string
): string | undefined {
  const running = probe('claude', ['--version'], cwd)
  const verdict = checkCliVersion({
    running,
    pinned: runPolicy.cliVersion,
    strictness: runPolicy.cliVersionStrictness
  })

  if (verdict.blocking) throw new ImplementAgentError(verdict.message)
  // Both a mismatch and an unusable pin say something worth hearing; a match,
  // an absent pin, and an unreadable CLI say nothing.
  if (verdict.message) console.warn(verdict.message)

  return parseCliVersion(running)
}

/**
 * Absolute path to the built command-guard hook script, which ships beside
 * this bundle. Throws when it can't be found: an unarmed guardrail is worse
 * than a refused run, because the run it would have guarded is autonomous and
 * the violation it would have blocked is only noticed once it has landed. The
 * only way to hit this is a broken install or a consumer importing this module
 * from source instead of from `dist/`.
 */
function resolveCommandGuardHookPath(): string {
  const bundleDir = resolveBundleDir()
  const hookPath = bundleDir && path.join(bundleDir, 'command-guard-hook.js')
  if (hookPath && fs.existsSync(hookPath)) return hookPath

  throw new ImplementAgentError(
    `Command-guard hook script not found at ${hookPath ?? '(unresolvable)'} — ` +
      'refusing to run unguarded against schema pushes, force-pushes, and ' +
      'amends. Reinstall @galosandoval/shopfloor, or import it from dist/.'
  )
}

/**
 * The directory this module was loaded from, in either module format: the ESM
 * build has `import.meta.url`, while the CJS build's bundler shims that away
 * and has `__filename` instead. Undefined if neither answers, which the caller
 * treats as "no hook to point at".
 */
function resolveBundleDir(): string | undefined {
  const moduleUrl = import.meta.url as string | undefined
  if (moduleUrl) return path.dirname(fileURLToPath(moduleUrl))
  if (typeof __filename === 'string') return path.dirname(__filename)
  return undefined
}

/**
 * Trimmed stdout of a resolution probe, or undefined when the command is
 * missing, fails, or says nothing. Probes are best-effort by design: the
 * caller turns an unanswered probe into an error naming what to state instead.
 */
function probe(file: string, args: string[], cwd: string): string | undefined {
  try {
    // execFile, not a shell string: an issue number off `argv` is caller input
    // and must never be word-split or interpolated into a command line.
    const output = execFileSync(file, args, {
      encoding: 'utf8',
      cwd,
      stdio: ['ignore', 'pipe', 'ignore']
    }).trim()
    return output || undefined
  } catch {
    return undefined
  }
}

/** The checked-out branch, for a local run with no CI environment to read. */
function probeBranch(cwd: string): string {
  const branch = probe('git', ['rev-parse', '--abbrev-ref', 'HEAD'], cwd)
  // A detached HEAD names no branch, and the agent's commits need one.
  if (!branch || branch === 'HEAD') {
    throw new ImplementAgentError(
      'No branch to implement on — pass `branch`, set BRANCH, or check out a branch.'
    )
  }
  return branch
}

/**
 * The issue's own title, so the prompt can never disagree with the issue it is
 * implementing. `gh` infers the repository from the checkout when the config
 * states none.
 */
function probeIssueTitle(
  issueNumber: string,
  repo: string | undefined,
  cwd: string
): string {
  const title = probe(
    'gh',
    [
      'issue',
      'view',
      issueNumber,
      ...(repo ? ['--repo', repo] : []),
      '--json',
      'title',
      '-q',
      '.title'
    ],
    cwd
  )
  if (!title) {
    throw new ImplementAgentError(
      `Could not read the title of issue #${issueNumber} via gh — pass ` +
        '`issueTitle` or set ISSUE_TITLE.'
    )
  }
  return title
}

function fileHasContent(file: string): boolean {
  try {
    return fs.readFileSync(file, 'utf8').trim().length > 0
  } catch {
    return false
  }
}
