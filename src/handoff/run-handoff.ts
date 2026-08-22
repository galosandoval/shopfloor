/**
 * The handoff artifact's IO shell (shopfloor#49): gather what the attempt left
 * behind, render it with the pure {@link renderHandoff}, and commit it to the
 * branch. The success path's counterpart — stripping the trail — is
 * `close-loop.ts`, and the commit identity both share is `git.ts`.
 *
 * **Nothing here throws.** A handoff is memory for the *next* attempt, and a
 * failed write must never replace the failure that is actually worth reporting.
 * Every step reports what it could not do and moves on, which is also why the
 * harness half is assembled from facts that are individually optional: a run
 * killed by a runaway guard has no claims, may have no diff, and may have no
 * scorecard, and it still gets a file. Why that half is written at all, and why
 * the two authorship halves never blend, is on {@link renderHandoff}.
 */

import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import { spawn } from 'node:child_process'
import type { TrajectoryFinding } from '../observability/trajectory'
import type { FailedPhaseOutcome } from '../issue-state/transition'
import type { RunUsage } from '../observability/usage'
import { commitPaths, git } from './git'
import {
  attemptFileName,
  renderHandoff,
  HANDOFF_LOG_TAIL_LIMIT,
  type HandoffCiFailure,
  type HandoffDiff
} from './handoff'

export interface WriteHandoffInput {
  attempt: number
  maxAttempts: number
  issueNumber: number
  repo: string
  branch: string
  outcome: FailedPhaseOutcome
  /** How the attempt ended, in the harness's words — the error it threw. */
  failure: string
  /** The scorecard for this attempt, when the closure condition graded one. */
  scorecard?: readonly TrajectoryFinding[]
  /**
   * What the attempt spent, off the error it threw (shopfloor#50). Absent means
   * it never spawned — see {@link HandoffInput.usage}.
   */
  usage?: RunUsage
  /** Where the agent was told to write its claims (`{{HANDOFF_CLAIMS_FILE}}`). */
  claimsFile?: string
  /**
   * The CI run whose failure triggered this attempt, on the machine edge. The
   * logs are fetched here; a fetch failure degrades the artifact to URL-only.
   */
  ciFailure?: { runId: string; runUrl: string }
  /** Repo-relative directory the trail is committed under. */
  attemptsDir: string
  cwd: string
  env: NodeJS.ProcessEnv
}

export interface WriteHandoffResult {
  /** Repo-relative path of the file, whether or not the write got that far. */
  file: string
  written: boolean
  committed: boolean
  /** Why a step did not happen — best-effort means somebody has to say. */
  detail?: string
}

/**
 * Write this attempt's handoff and commit it to the branch.
 *
 * The harness-authored half is written **unconditionally**, including after a
 * wall-clock kill or a crash inside the run — the reasoning is on
 * {@link renderHandoff}, which is where the document's contract lives.
 */
export async function writeHandoff(
  input: WriteHandoffInput
): Promise<WriteHandoffResult> {
  const runId = await resolveRunId(input.env, input.cwd)
  const file = path.posix.join(input.attemptsDir, attemptFileName(runId))
  const absolute = path.join(input.cwd, file)

  const document = renderHandoff({
    runId,
    attempt: input.attempt,
    maxAttempts: input.maxAttempts,
    issueNumber: input.issueNumber,
    branch: input.branch,
    runUrl: runUrlFor(input.env),
    outcome: input.outcome,
    failure: input.failure,
    ciFailure: await gatherCiFailure(input),
    scorecard: input.scorecard,
    usage: input.usage,
    ...(await probeDiffStat(input.cwd)),
    claims: await readClaims(input.claimsFile),
    claimsUnavailable: claimsUnavailableReason(input.claimsFile)
  })

  try {
    await fs.mkdir(path.dirname(absolute), { recursive: true })
    await fs.writeFile(absolute, document, 'utf8')
    // Staged here rather than inside `commitPaths`: this is the one of the two
    // callers whose path is *new*, and the strip's is already staged by its own
    // `git rm`. An `add` there would fail on a pathspec matching nothing in
    // either the worktree or the index, and take the commit with it.
    await git(input.cwd, ['add', '--', file])
  } catch (error) {
    return { file, written: false, committed: false, detail: String(error) }
  }

  const commit = await commitPaths(
    input.cwd,
    [file],
    `chore(shopfloor): handoff for attempt ${input.attempt} on issue #${input.issueNumber}`
  )

  return {
    file,
    written: true,
    committed: commit.committed,
    detail: commit.detail
  }
}

/**
 * A bounded tail of the failing run's logs, or the reason there is none.
 *
 * URL-only would make the loop blind on its only automated edge — the next
 * attempt's whole advantage is knowing what broke without re-running anything —
 * so the fetch is worth making. It is still best-effort: a `gh` that cannot
 * read the logs degrades the artifact rather than failing the run.
 *
 * **The bound is enforced here, while reading, not only when rendering.** An
 * earlier version buffered the whole of `gh run view --log-failed` and bounded
 * the result, which inverted the guarantee exactly where it mattered: the runs
 * whose logs are large enough to exhaust a buffer are the runs that failed
 * loudest, and they were the ones degraded to URL-only. Streaming a rolling
 * tail means log volume can no longer cost the next attempt its evidence.
 */
async function gatherCiFailure(
  input: WriteHandoffInput
): Promise<HandoffCiFailure | undefined> {
  if (!input.ciFailure) return undefined

  const { runId, runUrl } = input.ciFailure

  try {
    const { tail, totalChars } = await streamTail(
      'gh',
      ['run', 'view', runId, '--repo', input.repo, '--log-failed'],
      input.cwd
    )

    if (!tail.trim()) {
      return { runUrl, logUnavailable: 'gh returned no failing-step logs' }
    }

    return totalChars > tail.length
      ? { runUrl, logTail: tail, logTotalChars: totalChars }
      : { runUrl, logTail: tail }
  } catch (error) {
    return { runUrl, logUnavailable: String(error) }
  }
}

/**
 * How much more than the rendered bound to keep while streaming. The document
 * cuts to {@link HANDOFF_LOG_TAIL_LIMIT}; keeping a little more here means the
 * fetch is not silently deciding where the cut lands, and the reported total is
 * still the true one either way.
 */
const STREAM_TAIL_HEADROOM = 4

/**
 * Run a command and keep only the last {@link HANDOFF_LOG_TAIL_LIMIT}-ish
 * characters of its stdout, reporting how much there was in total.
 *
 * Memory stays flat however long the command talks, which is the whole point:
 * the alternative is a buffer limit, and a buffer limit turns a verbose failure
 * into no evidence at all.
 */
function streamTail(
  command: string,
  args: string[],
  cwd: string
): Promise<{ tail: string; totalChars: number }> {
  const keep = HANDOFF_LOG_TAIL_LIMIT * STREAM_TAIL_HEADROOM

  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd })
    let tail = ''
    let totalChars = 0
    let stderr = ''

    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => {
      totalChars += chunk.length
      tail = (tail + chunk).slice(-keep)
    })

    child.stderr.setEncoding('utf8')
    // Bounded for the same reason stdout is, and smaller: this only ever ends up
    // in a failure message.
    child.stderr.on('data', (chunk: string) => {
      stderr = (stderr + chunk).slice(-2000)
    })

    child.on('error', reject)
    child.on('close', (code) => {
      if (code === 0) return resolve({ tail, totalChars })
      reject(
        new Error(
          `${command} exited with code ${code}${stderr.trim() ? `: ${stderr.trim()}` : ''}`
        )
      )
    })
  })
}

/**
 * What the attempt changed, summarized against the base branch — or the reason
 * there is no summary.
 *
 * **The base is resolved, never assumed.** A hardcoded `main` yields nothing on
 * a repository whose default branch is not one, and the document would render
 * that as "nothing was committed" — present, wrong, and silent, which is the
 * failure shape this package keeps eliminating. `origin/HEAD` is what the
 * remote says its default branch is; {@link FALLBACK_BASE_BRANCH} is the last
 * resort, and a diff that still fails is *reported* rather than rendered as an
 * empty one.
 */
async function probeDiffStat(cwd: string): Promise<HandoffDiff> {
  const base = await resolveBaseBranch(cwd)

  try {
    // Three-dot: what this branch added since it left the base, rather than
    // everything the base has gained meanwhile — a retrigger days later would
    // otherwise summarize other people's work as this attempt's.
    const { stdout } = await git(cwd, ['diff', '--stat', `${base}...HEAD`])
    return { diffStat: stdout.trim() || undefined }
  } catch (error) {
    return {
      diffUnavailable: `could not diff against ${base}: ${String(error)}`
    }
  }
}

/** Where the branch forked from, when nothing names the default branch. */
const FALLBACK_BASE_BRANCH = 'main'

/** The remote's own default branch, falling back rather than failing. */
async function resolveBaseBranch(cwd: string): Promise<string> {
  try {
    const { stdout } = await git(cwd, [
      'symbolic-ref',
      '--short',
      'refs/remotes/origin/HEAD'
    ])
    return stdout.trim() || FALLBACK_BASE_BRANCH
  } catch {
    return FALLBACK_BASE_BRANCH
  }
}

/**
 * Why there are no claims, in terms the harness can actually stand behind: the
 * file it looked in, or that nothing pointed it at one. Deliberately **not** a
 * story about *how* the attempt ended — a kill, a crash, and an agent that
 * simply skipped the file are indistinguishable from here, and a sentence
 * naming one of them would be the harness guessing in the one document written
 * to keep guesses out of facts. How it ended is stated once, above, from the
 * error the run actually threw.
 */
function claimsUnavailableReason(claimsFile: string | undefined): string {
  return claimsFile
    ? `the attempt wrote nothing to ${claimsFile}`
    : 'this run pointed the agent at no claims file'
}

/** The agent's own account, or undefined when it never wrote one. */
async function readClaims(
  file: string | undefined
): Promise<string | undefined> {
  if (!file) return undefined

  try {
    const claims = await fs.readFile(file, 'utf8')
    return claims.trim() || undefined
  } catch {
    return undefined
  }
}

/**
 * This attempt's own run id — `GITHUB_RUN_ID`, or the head commit when there is
 * no CI run to name. A re-run of the same workflow run reuses the id, so
 * `GITHUB_RUN_ATTEMPT` joins it when there is one: two attempts writing one
 * filename would silently overwrite the earlier one's memory.
 */
async function resolveRunId(
  env: NodeJS.ProcessEnv,
  cwd: string
): Promise<string> {
  const runId = env.GITHUB_RUN_ID?.trim()
  if (runId) {
    const rerun = Number(env.GITHUB_RUN_ATTEMPT)
    return rerun > 1 ? `${runId}-${rerun}` : runId
  }

  try {
    const { stdout } = await git(cwd, ['rev-parse', '--short', 'HEAD'])
    const sha = stdout.trim()
    if (sha) return `local-${sha}`
  } catch {
    // fall through — a run id that names nothing is still a filename
  }

  return 'local'
}

/** Where this attempt's own logs are, when the runner said. */
function runUrlFor(env: NodeJS.ProcessEnv): string | undefined {
  const { GITHUB_RUN_ID, GITHUB_REPOSITORY } = env
  if (!GITHUB_RUN_ID || !GITHUB_REPOSITORY) return undefined

  const server = env.GITHUB_SERVER_URL ?? 'https://github.com'
  return `${server}/${GITHUB_REPOSITORY}/actions/runs/${GITHUB_RUN_ID}`
}
