import * as fs from 'node:fs'
import { execSync, spawn } from 'node:child_process'
import { captureTranscript } from '../observability/transcript'
import { prepareClaudeInvocation } from './claude-invocation'
import {
  findMissingEnvVars,
  resolveIdleMs,
  type RunPolicyConfig
} from '../guardrails/run-policy'

/**
 * Orchestrator for a single "implement this issue" agent run (ported from
 * recipe-chat-v1's `agent/implement/implement.ts`, #510/#540/#556). Spawns
 * the Claude Code CLI directly and owns the run's runaway guards: an idle
 * timeout (output-silence guard) and a zero-commit failure check. The caller
 * owns everything outside the run itself — checking out the branch, opening
 * the PR, sandboxing (an ephemeral CI runner or a container).
 */

export class ImplementAgentError extends Error {
  /** Bounded tail of the CLI's combined stdout/stderr, when available. */
  readonly outputTail?: string

  constructor(message: string, outputTail?: string) {
    super(message)
    this.name = 'ImplementAgentError'
    this.outputTail = outputTail
  }
}

export interface RunImplementAgentConfig {
  issueNumber: string
  issueTitle: string
  branch: string
  /** Subscription / flat-rate token — never `ANTHROPIC_API_KEY` (metered). */
  claudeCodeOAuthToken: string
  /** Absolute path to coding-standard rules, or `''` to skip that prompt step. */
  standardsDir: string
  /** Raw contents of the prompt template, with `{{PLACEHOLDER}}` tokens to render. */
  promptTemplate: string
  /** Path the agent writes its PR description to; a fallback is written here if empty. */
  prDescriptionFile: string
  /** Path the agent writes its verify-phase report to. */
  verifyReportFile: string
  /** Repo-relative dir the agent commits verify-phase screenshots into. */
  screenshotsDir: string
  /** Where to copy the agent's Claude Code session transcript for audit. */
  transcriptFile: string
  /** Claude Code's session store, e.g. `$HOME/.claude/projects`. */
  projectsDir: string
  runPolicy: RunPolicyConfig
  /** Defaults to `process.env`. */
  env?: NodeJS.ProcessEnv
  /** Defaults to `process.cwd()` — where the CLI spawns and `git rev-list` runs. */
  cwd?: string
}

export interface RunImplementAgentResult {
  /** Commits made on `branch` since `main`, per `git rev-list --count`. */
  commitsAhead: number
  transcriptCaptured: boolean
  /** Whether the agent wrote its own PR description, or this run fell back to one. */
  prDescription: 'agent' | 'fallback'
}

/**
 * Runs the agent once: validates the caller's app-specific required env vars,
 * spawns the Claude Code CLI with the idle guard armed, captures the session
 * transcript, and verifies the run actually committed. Throws
 * {@link ImplementAgentError} on any failure — callers own translating that
 * into their own CI-glue (writing a failure-reason file, exiting non-zero).
 */
export async function runImplementAgent(
  config: RunImplementAgentConfig
): Promise<RunImplementAgentResult> {
  const env = config.env ?? process.env
  const cwd = config.cwd ?? process.cwd()

  // Validate the whole contract-required env up front, before the Claude CLI
  // spawns, so a missing var fails immediately naming every offender instead
  // of spending tokens on a doomed run.
  const missingEnv = findMissingEnvVars(config.runPolicy.requiredEnvVars, env)
  if (missingEnv.length > 0) {
    throw new ImplementAgentError(
      `Missing required env var(s): ${missingEnv.join(', ')}`
    )
  }

  const { args, prompt } = prepareClaudeInvocation({
    promptTemplate: config.promptTemplate,
    issueNumber: config.issueNumber,
    issueTitle: config.issueTitle,
    branch: config.branch,
    prDescriptionFile: config.prDescriptionFile,
    standardsDir: config.standardsDir,
    verifyReportFile: config.verifyReportFile,
    screenshotsDir: config.screenshotsDir,
    model: config.runPolicy.model,
    maxTurns: config.runPolicy.maxTurns,
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
  const captureRunTranscript = () =>
    captureTranscript({
      projectsDir: config.projectsDir,
      destPath: config.transcriptFile
    })

  const { exitCode, idleKilled, outputTail } = await spawnClaude({
    args,
    prompt,
    env: childEnv,
    cwd,
    idleMs,
    onSpawnError: captureRunTranscript
  })

  // Copy the agent's session transcript out for the caller to upload as an
  // audit artifact. Best-effort; there's exactly one session per run, so the
  // newest-JSONL scan inside captureTranscript resolves it unambiguously.
  const transcriptCaptured = captureRunTranscript()

  if (idleKilled) {
    throw new ImplementAgentError(
      `Agent idle for over ${Math.round(idleMs / 60_000)} minute(s) — killed by the idle guard.`,
      outputTail
    )
  }

  if (exitCode !== 0) {
    throw new ImplementAgentError(
      `Claude CLI exited with status ${exitCode}.`,
      outputTail
    )
  }

  // The agent commits its own TDD work; a zero-commit run is a failure, not a PR.
  const commitsAhead = Number(
    execSync('git rev-list --count main..HEAD', { encoding: 'utf8', cwd }).trim()
  )
  if (!Number.isFinite(commitsAhead) || commitsAhead === 0) {
    throw new ImplementAgentError('Agent finished but made no commits on the branch.')
  }

  // Without a description the PR body would be just `Closes #N`. Fall back
  // rather than discard otherwise-green commits.
  let prDescription: RunImplementAgentResult['prDescription'] = 'agent'
  if (!fileHasContent(config.prDescriptionFile)) {
    prDescription = 'fallback'
    fs.writeFileSync(
      config.prDescriptionFile,
      `Implements #${config.issueNumber}: ${config.issueTitle}\n`
    )
  }

  return { commitsAhead, transcriptCaptured, prDescription }
}

interface SpawnClaudeResult {
  exitCode: number
  idleKilled: boolean
  /** Bounded tail of the CLI's combined stdout/stderr, kept for failure diagnostics. */
  outputTail: string
}

/**
 * Spawns the Claude CLI, piping its output to this process's own
 * stdout/stderr for the caller's job log while watching for the idle
 * runaway guard: a run killed once its output goes quiet for `idleMs`.
 */
async function spawnClaude(opts: {
  args: string[]
  prompt: string
  env: NodeJS.ProcessEnv
  cwd: string
  idleMs: number
  onSpawnError: () => void
}): Promise<SpawnClaudeResult> {
  const TAIL_BYTES = 4000
  const IDLE_CHECK_INTERVAL_MS = 15_000

  let outputTail = ''
  const captureTail = (chunk: Buffer) => {
    outputTail = (outputTail + chunk.toString('utf8')).slice(-TAIL_BYTES)
  }

  let idleKilled = false

  try {
    const exitCode = await new Promise<number>((resolve, reject) => {
      const child = spawn('claude', [...opts.args, opts.prompt], {
        env: opts.env,
        cwd: opts.cwd
      })
      let lastActivity = Date.now()
      const markActive = () => {
        lastActivity = Date.now()
      }
      child.stdout.on('data', (chunk: Buffer) => {
        process.stdout.write(chunk)
        captureTail(chunk)
        markActive()
      })
      child.stderr.on('data', (chunk: Buffer) => {
        process.stderr.write(chunk)
        captureTail(chunk)
        markActive()
      })
      const idleTimer = setInterval(() => {
        if (Date.now() - lastActivity > opts.idleMs) {
          idleKilled = true
          console.error(
            `\nFAILED: idle guard tripped after ${Math.round(opts.idleMs / 60_000)} minute(s) — killing the agent.`
          )
          child.kill('SIGKILL')
        }
      }, IDLE_CHECK_INTERVAL_MS)
      child.on('error', (error) => {
        clearInterval(idleTimer)
        reject(error)
      })
      child.on('close', (code) => {
        clearInterval(idleTimer)
        resolve(code ?? 1)
      })
    })
    return { exitCode, idleKilled, outputTail }
  } catch (error) {
    opts.onSpawnError()
    throw new ImplementAgentError(
      `Failed to start the Claude CLI: ${String(error)}`
    )
  }
}

function fileHasContent(file: string): boolean {
  try {
    return fs.readFileSync(file, 'utf8').trim().length > 0
  } catch {
    return false
  }
}
