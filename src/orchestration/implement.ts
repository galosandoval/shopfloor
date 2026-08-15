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
import {
  captureTranscript,
  preserveIterationTranscript
} from '../observability/transcript'
import { prepareClaudeInvocation } from './claude-invocation'
import {
  describeRunawayKill,
  spawnClaude,
  type SpawnClaudeResult
} from './spawn-claude'
import { evaluateIteration } from './iteration'
import { runGate } from './gate'
import {
  findMissingEnvVars,
  resolveIdleMs,
  resolveWallClockMs,
  type ResolvedRunPolicy
} from '../guardrails/run-policy'
import { checkCliVersion, parseCliVersion } from '../guardrails/cli-version'
import { runPluginDirsCheck } from '../guardrails/run-plugin-dirs'
import { resolveBundledPluginDir } from './bundled-plugin'
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
  /**
   * How many times this run spawned the CLI. Always 1 unless
   * `runPolicy.gateCommand` is stated — only a run with a gate can iterate.
   */
  iterations: number
}

/**
 * Runs the agent: resolves the caller's configuration (filling anything
 * unstated from the environment, a `git` / `gh` probe, or a package default),
 * settles every pre-spawn precondition (see {@link verifyPreconditions}),
 * spawns the Claude Code CLI with both runaway guards armed, captures the
 * session transcript, and verifies the run actually committed. Throws
 * {@link ImplementAgentError} on any failure — callers own translating that
 * into their own CI-glue (writing a failure-reason file, exiting non-zero).
 *
 * With a `runPolicy.gateCommand` stated it runs that gate after each spawn and
 * spawns again on a failure, carrying the failure into the next prompt, until
 * the gate passes or a budget is spent (shopfloor#40). Without one it is
 * single-shot, as it has always been.
 */
export async function runImplementAgent(
  input: RunImplementAgentConfig
): Promise<RunImplementAgentResult> {
  const env = input.env ?? process.env
  const config = resolveImplementConfig(input, env)
  const cwd = config.cwd ?? process.cwd()

  // An unstated list resolves to the bundled plugin; a stated one replaces it,
  // including a stated empty one — "deliberately no plugins at all".
  const pluginDirs = config.pluginDirs ?? [resolveBundledPluginDir()]

  const cliVersion = verifyPreconditions(config, pluginDirs, env, cwd)

  const branch = config.branch ?? probeBranch(cwd)
  const issueTitle =
    config.issueTitle ?? probeIssueTitle(config.issueNumber, config.repo, cwd)

  // Never let the child fall through to a metered API key, even if the
  // invoking environment happens to have one set — auth must be OAuth-only.
  const childEnv = {
    ...env,
    CLAUDE_CODE_OAUTH_TOKEN: config.claudeCodeOAuthToken
  }
  delete (childEnv as Record<string, unknown>).ANTHROPIC_API_KEY

  const { iterations, transcriptCaptured } = await runIterations({
    config,
    env,
    childEnv,
    cwd,
    pluginDirs,
    branch,
    issueTitle,
    commandGuardHookPath: resolveCommandGuardHookPath()
  })

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

  return {
    branch,
    commitsAhead,
    transcriptCaptured,
    prDescription,
    cliVersion,
    iterations
  }
}

/**
 * Everything the inner loop needs that the run already settled. One type rather
 * than a dozen parameters, since every field travels together and none of it is
 * decided here.
 */
interface IterationLoopContext {
  config: ResolvedImplementConfig
  /** The run's own environment — what the gate sees. */
  env: Record<string, string | undefined>
  /** The CLI's environment: OAuth token injected, `ANTHROPIC_API_KEY` stripped. */
  childEnv: NodeJS.ProcessEnv
  cwd: string
  pluginDirs: string[]
  branch: string
  issueTitle: string
  commandGuardHookPath: string
}

/**
 * The inner loop (shopfloor#40): spawn, run the caller's gate, and — while the
 * budgets allow — spawn again carrying what the gate said. A run with no
 * `gateCommand` stated leaves after one pass, exactly as every run did before
 * this loop existed.
 *
 * The decision itself is `evaluateIteration`, pure and next door; this is the
 * IO around it. It throws rather than returning a failure, because every way
 * out of this loop other than a passing gate is a failed run.
 *
 * **`transcriptFile` is the last iteration's, and no earlier one is lost.**
 * Each pass copies the session it just wrote over `config.transcriptFile`, so
 * before iterating, the attempt that just failed is kept beside it at
 * `transcript.iteration-<n>.jsonl`. Those failed attempts are the ones that
 * explain why a run needed the loop at all, and overwriting them would destroy
 * the evidence on exactly the runs worth auditing. A single-shot run writes no
 * such file, so nothing changes for a consumer who never states a gate.
 */
async function runIterations(
  ctx: IterationLoopContext
): Promise<{ iterations: number; transcriptCaptured: boolean }> {
  const { config, env, cwd } = ctx
  const idleMs = resolveIdleMs(config.runPolicy, env)
  const wallClockMs = resolveWallClockMs(config.runPolicy, env)
  const captureRunTranscript = () =>
    captureTranscript({
      projectsDir: config.projectsDir,
      destPath: config.transcriptFile
    })

  // The run's wall clock, spent across every spawn rather than granted afresh
  // to each: a ceiling that reset per iteration would be N times the number the
  // caller stated. The idle budget is per-spawn on purpose — it measures one
  // live process going quiet.
  let spentMs = 0
  const remainingWallClockMs = () =>
    wallClockMs === undefined ? undefined : wallClockMs - spentMs

  let transcriptCaptured = false
  let iterationFeedback: string | undefined

  for (let iteration = 1; ; iteration++) {
    const startedAt = Date.now()
    const { exitCode, killedBy, outputTail } = await spawnClaude({
      ...prepareClaudeInvocation({
        promptTemplate: config.promptTemplate,
        issueNumber: config.issueNumber,
        issueTitle: ctx.issueTitle,
        branch: ctx.branch,
        prDescriptionFile: config.prDescriptionFile,
        pluginDirs: ctx.pluginDirs,
        verifyReportFile: config.verifyReportFile,
        screenshotsDir: config.screenshotsDir,
        model: config.runPolicy.model,
        maxTurns: config.runPolicy.maxTurns,
        commandGuardHookPath: ctx.commandGuardHookPath,
        iterationFeedback,
        // Always stream: the idle guard watches the CLI's output for a
        // heartbeat, and `--print` text stays silent until the session ends.
        streamOutput: true
      }),
      env: ctx.childEnv,
      cwd,
      idleMs,
      wallClockMs: remainingWallClockMs(),
      onSpawnError: captureRunTranscript
    })

    // Copy the agent's session transcript out for the caller to upload as an
    // audit artifact. Best-effort; the newest-JSONL scan inside
    // captureTranscript resolves the session this iteration just wrote.
    transcriptCaptured = captureRunTranscript()

    requireFinishedSpawn({ exitCode, killedBy, outputTail })

    // The gate runs on the run's own environment, not the CLI's: the OAuth
    // token and the stripped `ANTHROPIC_API_KEY` exist to keep the *agent* off
    // a metered key, and the gate is not the agent. Handing it the token would
    // push a credential into a consumer command with no use for one.
    const gate = config.runPolicy.gateCommand
      ? runGate(config.runPolicy.gateCommand, { cwd, env })
      : undefined

    // Charged after the gate, not just after the spawn: a gate is normally the
    // whole test suite, and time the run spends inside it is time the run
    // spent. Billing only the spawn would let N iterations overrun the ceiling
    // by N gates.
    spentMs += Date.now() - startedAt

    const verdict = evaluateIteration({
      iteration,
      maxIterations: config.runPolicy.maxIterations,
      gate,
      remainingWallClockMs: remainingWallClockMs()
    })

    if (verdict.kind === 'done')
      return { iterations: iteration, transcriptCaptured }
    if (verdict.kind === 'exhausted') {
      throw new ImplementAgentError(verdict.reason, gate?.outputTail)
    }

    // Keep this attempt's transcript before the next spawn overwrites it: a
    // failed attempt is the one worth reading, and it is about to be replaced
    // by the attempt that fixed it.
    preserveIterationTranscript(config.transcriptFile, iteration)
    iterationFeedback = verdict.feedback
  }
}

/**
 * Fails the run unless the spawn ended on its own terms. A killed run fails
 * before the commit check, and deliberately stays that way for the wall-clock
 * guard too: a run cut off mid-loop never reached its own verify phase, so
 * whatever it committed is unvetted work-in-progress. That is why this doesn't
 * follow the leniency the missing PR description gets — there, the commits were
 * finished and only the prose was absent.
 *
 * It also ends the loop rather than feeding another iteration, whichever way it
 * failed: the loop corrects work the *gate* judged, and a spawn that never
 * finished produced nothing to judge.
 */
function requireFinishedSpawn({
  exitCode,
  killedBy,
  outputTail
}: SpawnClaudeResult): void {
  if (killedBy) {
    throw new ImplementAgentError(describeRunawayKill(killedBy), outputTail)
  }

  if (exitCode !== 0) {
    throw new ImplementAgentError(
      `Claude CLI exited with status ${exitCode}.`,
      outputTail
    )
  }
}

/**
 * Everything that must hold before the CLI spawns, so a misconfigured run
 * fails immediately instead of spending tokens on a doomed one: the caller's
 * required env vars, the plugin directories, and the CLI version. Returns the
 * running CLI version for the run result — the one thing these checks produce
 * rather than merely permit. The removed `standardsDir` refuses earlier still,
 * in `resolveImplementConfig`, since it needs no IO to detect.
 *
 * They differ in how hard they push back, and each difference is deliberate: a
 * missing env var or a rotted plugin directory is a misconfiguration that
 * changes what the run produces, while a drifted CLI is a diagnostic that only
 * sometimes matters. See {@link requirePluginDirs} and `checkCliVersion`.
 *
 * `pluginDirs` arrives resolved rather than read off `config`, because the
 * bundled default behind it is a filesystem lookup the pure resolver does not
 * do.
 */
function verifyPreconditions(
  config: ResolvedImplementConfig,
  pluginDirs: string[],
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

  requirePluginDirs(pluginDirs, cwd)
  return checkRunningCliVersion(config.runPolicy, cwd)
}

/**
 * Refuse before the spawn when any plugin directory fails validation. Stricter
 * than the CLI-version warn on purpose: a rotted plugin and a correct one are
 * indistinguishable once the flag is on the vector, so the run would quietly
 * produce work with none of the skills it was configured to have. An empty
 * list probes nothing.
 *
 * The bundled plugin gets no exemption. It reaches this as an ordinary entry
 * and is refused by the same rules, named by its own path — which is the
 * dependency's, so the refusal says which plugin it was without a second
 * message shape to keep in step with the first.
 */
function requirePluginDirs(pluginDirs: string[], cwd: string): void {
  if (pluginDirs.length === 0) return

  const verdict = runPluginDirsCheck(pluginDirs, cwd)
  if (verdict.refused) throw new ImplementAgentError(verdict.reason)
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
