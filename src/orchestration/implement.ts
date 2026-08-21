/**
 * Orchestrator for a single "implement this issue" agent run (ported from
 * recipe-chat-v1's `agent/implement/implement.ts`, #510/#540/#556). Spawns
 * the Claude Code CLI directly and owns the run's runaway budgets — an idle
 * timeout and a wall-clock ceiling, both enforced in {@link spawnClaude} — plus
 * a zero-commit failure check. It is also
 * the IO shell around the pure {@link resolveImplementConfig}: the `git` and
 * `gh` probes that answer what neither the caller nor the environment stated
 * live here.
 *
 * **Internal since shopfloor#47.** It is the phase's *run*, reached through
 * `runPhase`, which owns everything outside the run itself — the branch, the
 * pull request, and the issue's state. What is still outside both is the
 * checkout and the sandbox (an ephemeral CI runner or a container).
 */

import * as fs from 'node:fs'
import * as path from 'node:path'
import { execFileSync, execSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import {
  captureTranscript,
  preserveIterationTranscript
} from '../observability/transcript'
import {
  mergeRunUsage,
  NO_RUN_USAGE,
  type RunUsage
} from '../observability/usage'
import { prepareClaudeInvocation } from './claude-invocation'
import {
  describeRunawayKill,
  spawnClaude,
  type SpawnClaudeResult
} from './spawn-claude'
import { evaluateIteration, checkIterationBudget } from './iteration'
import { runGate } from './gate'
import {
  evaluateClosure,
  resolveGatePatterns,
  type ClosureVerdict
} from '../guardrails/closure'
import { runTrajectoryCheck } from '../observability/run-trajectory-check'
import type { TrajectoryFinding } from '../observability/trajectory'
import {
  findMissingEnvVars,
  resolveIdleMs,
  resolveWallClockMs,
  type ResolvedRunPolicy
} from '../guardrails/run-policy'
import { checkCliVersion, parseCliVersion } from '../guardrails/cli-version'
import { evaluatePromptReadiness } from '../guardrails/prompt-readiness'
import { PROMPT_TOKENS } from '../setup/setup'
import { runPluginDirsCheck } from '../guardrails/run-plugin-dirs'
import { runLabelVocabularyCheck } from '../guardrails/run-label-vocabulary'
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
  /**
   * Whether the session transcript was found and copied to `transcriptFile`.
   * Always `true` on a result since shopfloor#48 — an attempt that was not
   * captured cannot close the run — and kept because a caller reading it as
   * "there is a transcript to upload" still gets the right answer.
   */
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
   * How many times this run spawned the CLI. 1 unless
   * `runPolicy.gateCommand` is stated and the gate went red, or the closure
   * condition sent the run round again (shopfloor#48) — that second signal is
   * the one case a gateless run iterates.
   */
  iterations: number
  /**
   * What the run spent, summed over every one of its iterations, read off the
   * CLI's own `stream-json` (shopfloor#42). It sits beside `iterations`
   * deliberately: the inner loop bounds a run by attempts, and this is the
   * budget those attempts actually multiply. Check
   * {@link RunUsage.source} before treating the numbers as a total — see
   * `usage.ts`.
   */
  usage: RunUsage
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
 * the gate passes or a budget is spent (shopfloor#40).
 *
 * A green gate is not on its own enough to finish: every attempt is graded
 * against its own transcript, and one that violates a gating trajectory
 * invariant re-enters the loop or blocks (shopfloor#48). That is also the one
 * thing that makes a run with no gate stated spawn more than once.
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

  const cliVersion = await verifyPreconditions(config, pluginDirs, env, cwd)

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

  const { iterations, transcriptCaptured, usage } = await runIterations({
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
      'Agent finished but made no commits on the branch.',
      undefined,
      // The most expensive way to produce nothing, and the failure most worth
      // seeing a price on.
      usage
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
    iterations,
    usage
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
async function runIterations(ctx: IterationLoopContext): Promise<{
  iterations: number
  transcriptCaptured: boolean
  usage: RunUsage
}> {
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
  // Spend, like the wall clock and unlike the idle budget, belongs to the run:
  // every iteration is a fresh session paying for its static context again, and
  // a total that reported only the last one would understate an iterating run by
  // exactly the multiple the loop introduced.
  let usage = NO_RUN_USAGE

  for (let iteration = 1; ; iteration++) {
    const startedAt = Date.now()
    const spawnResult = await spawnClaude({
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

    // Folded before the spawn is judged, so the failures below carry what the
    // run had already spent rather than losing it on the way out.
    usage = mergeRunUsage(usage, spawnResult.usage)

    requireFinishedSpawn(spawnResult, usage)

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

    if (verdict.kind === 'exhausted') {
      throw new ImplementAgentError(verdict.reason, gate?.outputTail, usage, {
        // The one failure the state machine treats as its own outcome — see
        // `ImplementAgentError.exhausted` and `evaluatePhaseOutcome`.
        exhausted: true
      })
    }

    let feedback = verdict.kind === 'iterate' ? verdict.feedback : undefined

    // A green gate is where a run used to end. Since shopfloor#48 it is where
    // the run asks a second question: did the work get here the way it claims
    // to have? A trajectory that violates a gating invariant either spends
    // another attempt on it or blocks — it never closes as a success.
    if (verdict.kind === 'done') {
      const closure = judgeClosure(ctx, {
        iteration,
        remainingWallClockMs: remainingWallClockMs(),
        transcriptCaptured
      })

      if (closure.kind === 'pass')
        return { iterations: iteration, transcriptCaptured, usage }
      if (closure.kind === 'block') {
        throw new ImplementAgentError(closure.reason, gate?.outputTail, usage, {
          closure
        })
      }
      feedback = closure.feedback
    }

    // Keep this attempt's transcript before the next spawn overwrites it: a
    // failed attempt is the one worth reading, and it is about to be replaced
    // by the attempt that fixed it.
    preserveIterationTranscript(config.transcriptFile, iteration)
    iterationFeedback = feedback
  }
}

/**
 * Grade the attempt that just finished and ask whether the run may close
 * (shopfloor#48). Gather → decide, with the decision next door and pure: this
 * reads the transcript and hands the scorecard, and the loop's remaining room,
 * to {@link evaluateClosure}.
 *
 * The budget it reports is the *same* one `evaluateIteration` measures — a red
 * gate and an unclosed trajectory both spend attempts out of one ceiling, and
 * two ceilings measured separately is how a ceiling stops being one.
 *
 * **A run with no `gateCommand` can iterate here, and only here.** Without a
 * gate there is no signal to iterate on and the run is single-shot; the
 * trajectory is a second signal, and unlike the gate it needs no consumer
 * configuration, because the invariants it grades are this package's own.
 */
function judgeClosure(
  ctx: IterationLoopContext,
  attempt: {
    iteration: number
    remainingWallClockMs?: number
    /** Whether capture wrote *this* attempt's session — see below. */
    transcriptCaptured: boolean
  }
): ClosureVerdict {
  const { runPolicy } = ctx.config

  return evaluateClosure({
    findings: gradeAttempt(ctx, attempt.transcriptCaptured),
    budgetRemaining: checkIterationBudget({
      iteration: attempt.iteration,
      remainingWallClockMs: attempt.remainingWallClockMs,
      maxIterations: runPolicy.maxIterations
    }).available
  })
}

/**
 * The scorecard for the attempt that just ran, or **null** when there is none
 * of that attempt's to grade.
 *
 * **A readable file is not the question; a captured one is.** `captureTranscript`
 * returns false without touching its destination, and `preserveIterationTranscript`
 * copies rather than moves — so a failed capture on iteration N leaves iteration
 * N-1's session (or, for a caller-supplied path, an entirely earlier run's)
 * sitting at `transcriptFile`, readable and wrong. Grading that would close the
 * run on evidence about a different attempt, which is precisely the walk-past
 * this gate exists to refuse. So an uncaptured attempt is `null` and never
 * reaches the checker at all.
 */
function gradeAttempt(
  ctx: IterationLoopContext,
  transcriptCaptured: boolean
): TrajectoryFinding[] | null {
  if (!transcriptCaptured) return null

  const { runPolicy, transcriptFile } = ctx.config
  const check = runTrajectoryCheck({
    transcriptFile,
    maxTurns: runPolicy.maxTurns,
    gateCommandPatterns: resolveGatePatterns(runPolicy.gateCommand)
  })

  return check.graded ? check.findings : null
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
 *
 * @param usage - What the run had spent, this spawn included. It rides out on
 * the failure because a killed run is the one whose cost is least visible and
 * most worth knowing, and it never reaches a run result to be reported on.
 */
function requireFinishedSpawn(
  { exitCode, killedBy, outputTail }: SpawnClaudeResult,
  usage: RunUsage
): void {
  if (killedBy) {
    throw new ImplementAgentError(
      describeRunawayKill(killedBy),
      outputTail,
      usage
    )
  }

  if (exitCode !== 0) {
    throw new ImplementAgentError(
      `Claude CLI exited with status ${exitCode}.`,
      outputTail,
      usage
    )
  }
}

/**
 * Everything that must hold before the CLI spawns, so a misconfigured run
 * fails immediately instead of spending tokens on a doomed one: the caller's
 * required env vars, the prompt being filled in, the plugin directories, the
 * label vocabulary the run's issue transitions are written against, and
 * the CLI version. Returns the
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
async function verifyPreconditions(
  config: ResolvedImplementConfig,
  pluginDirs: string[],
  env: Record<string, string | undefined>,
  cwd: string
): Promise<string | undefined> {
  // Validate the whole contract-required env up front, so a missing var fails
  // immediately naming every offender.
  const missingEnv = findMissingEnvVars(config.runPolicy.requiredEnvVars, env)
  if (missingEnv.length > 0) {
    throw new ImplementAgentError(
      `Missing required env var(s): ${missingEnv.join(', ')}`
    )
  }

  requireFilledPrompt(config.promptTemplate)
  requirePluginDirs(pluginDirs, cwd)
  await requireLabelVocabulary(config.repo, cwd)
  return checkRunningCliVersion(config.runPolicy, cwd)
}

/**
 * Refuse before the spawn when the repository does not carry the labels this
 * run's issue transitions are written against (shopfloor#45). **Verify, never
 * create:** the write belongs to `shopfloor init`, at a moment a human asked
 * for it, because creating labels is a durable change to a shared human
 * workspace that the harness cannot cleanly reverse. Verification is what makes
 * a transition onto a label that does not exist impossible; creation never was.
 *
 * It sits after the local checks and before the CLI probe, so the network round
 * trip is only spent on a run that is otherwise configured to work.
 */
async function requireLabelVocabulary(
  repo: string | undefined,
  cwd: string
): Promise<void> {
  const verdict = await runLabelVocabularyCheck({ repo, cwd })
  if (verdict.refused) throw new ImplementAgentError(verdict.reason)
}

/**
 * Refuse before the spawn when the prompt was scaffolded and never filled, or
 * names a token nothing renders (shopfloor#44). Runs ahead of the plugin and
 * version probes because it needs nothing from disk, and the run it saves is
 * the one that would have spent a full budget before failing on a command this
 * repository does not have.
 */
function requireFilledPrompt(promptTemplate: string): void {
  const verdict = evaluatePromptReadiness({
    prompt: promptTemplate,
    knownTokens: PROMPT_TOKENS
  })
  if (verdict.refused) throw new ImplementAgentError(verdict.reason)
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
