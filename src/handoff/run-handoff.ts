/**
 * The handoff artifact's IO shell (shopfloor#49): gather what the attempt left
 * behind, render it with the pure {@link renderHandoff}, and commit it to the
 * branch — or, when the run succeeded, strip the whole trail.
 *
 * **Nothing here throws.** A handoff is memory for the *next* attempt, and a
 * failed write must never replace the failure that is actually worth reporting.
 * Every step reports what it could not do and moves on, which is also why the
 * harness half is assembled from facts that are individually optional: a run
 * killed by a runaway guard has no claims, may have no diff, and may have no
 * scorecard, and it still gets a file.
 *
 * **The commits are authored as the agent, deliberately.** The machine edge is
 * keyed on the head commit's author (`AGENT_COMMIT_AUTHOR`, design §6), and
 * these commits land on top of the agent's own before the push. A handoff
 * committed under the runner's ambient identity would make the head commit
 * somebody else's work, and the retrigger this artifact exists to inform would
 * never fire. `--no-verify` for the same class of reason: a consumer's
 * pre-commit hook failing is not a reason to lose the one record of why the
 * attempt failed.
 */

import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import type { TrajectoryFinding } from '../observability/trajectory'
import type { FailedPhaseOutcome } from '../issue-state/transition'
import { AGENT_COMMIT_AUTHOR } from '../trigger/classify'
import {
  attemptFileName,
  renderHandoff,
  type HandoffCiFailure,
  type HandoffDiff
} from './handoff'

const execFileAsync = promisify(execFile)

/** The email half of the identity above — what `git -c user.email` is given. */
const AGENT_COMMIT_EMAIL = `${AGENT_COMMIT_AUTHOR}@users.noreply.github.com`

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
 * wall-clock kill or a crash inside the run. Those are exactly the attempts the
 * ceiling exists to stop and exactly the ones that would otherwise teach the
 * next iteration nothing; only the agent's claims are legitimately unavailable
 * there, and the document says so rather than omitting the section.
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

export interface StripAttemptsResult {
  stripped: boolean
  /** How many attempt files were removed. */
  removed: number
  detail?: string
}

/**
 * Remove the whole trail and commit the removal — the success path, in the
 * commit the successful run is about to push.
 *
 * **All of them, and only on success.** They are kept on the exhausted terminal
 * state, where the PR stays open and the trail is the best account of what went
 * wrong that anyone has; design §4 posts it as the comment. A run that merely
 * failed keeps them too, because the next attempt is the whole reason they were
 * written.
 */
export async function stripAttempts(input: {
  attemptsDir: string
  cwd: string
}): Promise<StripAttemptsResult> {
  const tracked = await trackedAttempts(input)

  if (tracked.length === 0) {
    return { stripped: false, removed: 0 }
  }

  try {
    await git(input.cwd, ['rm', '-r', '--quiet', '--', input.attemptsDir])
  } catch (error) {
    return { stripped: false, removed: 0, detail: String(error) }
  }

  const commit = await commitPaths(
    input.cwd,
    [input.attemptsDir],
    'chore(shopfloor): strip the attempt handoffs — the run succeeded'
  )

  return {
    stripped: commit.committed,
    removed: tracked.length,
    detail: commit.detail
  }
}

/** The attempt files git already has, so a strip with nothing to strip commits nothing. */
async function trackedAttempts(input: {
  attemptsDir: string
  cwd: string
}): Promise<string[]> {
  try {
    const { stdout } = await git(input.cwd, [
      'ls-files',
      '--',
      input.attemptsDir
    ])
    return stdout.split('\n').filter((line) => line.trim())
  } catch {
    return []
  }
}

/**
 * A bounded tail of the failing run's logs, or the reason there is none.
 *
 * URL-only would make the loop blind on its only automated edge — the next
 * attempt's whole advantage is knowing what broke without re-running anything —
 * so the fetch is worth making. It is still best-effort: a `gh` that cannot
 * read the logs degrades the artifact rather than failing the run.
 */
async function gatherCiFailure(
  input: WriteHandoffInput
): Promise<HandoffCiFailure | undefined> {
  if (!input.ciFailure) return undefined

  const { runId, runUrl } = input.ciFailure

  try {
    const { stdout } = await execFileAsync(
      'gh',
      ['run', 'view', runId, '--repo', input.repo, '--log-failed'],
      { cwd: input.cwd, maxBuffer: MAX_LOG_BUFFER }
    )
    const logTail = stdout.trim()
    return logTail
      ? { runUrl, logTail }
      : { runUrl, logUnavailable: 'gh returned no failing-step logs' }
  } catch (error) {
    return { runUrl, logUnavailable: String(error) }
  }
}

/**
 * `gh run view --log-failed` streams whole job logs, which are routinely larger
 * than Node's 1 MB default. The document keeps a bounded tail of this; what the
 * bound here prevents is the fetch failing outright on a verbose run and
 * degrading a handoff that had logs available.
 */
const MAX_LOG_BUFFER = 32 * 1024 * 1024

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

/**
 * Commit exactly these paths, as the agent, skipping the consumer's hooks.
 *
 * Path-limited rather than a bare `git commit -a`: whatever else is in the
 * working tree belongs to the agent's own commits, and sweeping it into a
 * bookkeeping commit would attribute work to a message about a handoff.
 *
 * It stages nothing — each caller has already staged what it is committing, and
 * for different reasons: the write path `add`s a file git has never seen, while
 * the strip's `git rm` stages its own deletion and leaves a pathspec that
 * matches nothing anywhere.
 */
async function commitPaths(
  cwd: string,
  paths: string[],
  message: string
): Promise<{ committed: boolean; detail?: string }> {
  try {
    await git(cwd, [
      '-c',
      `user.name=${AGENT_COMMIT_AUTHOR}`,
      '-c',
      `user.email=${AGENT_COMMIT_EMAIL}`,
      'commit',
      '--no-verify',
      '-m',
      message,
      '--',
      ...paths
    ])
    return { committed: true }
  } catch (error) {
    return { committed: false, detail: String(error) }
  }
}

function git(
  cwd: string,
  args: string[]
): Promise<{ stdout: string; stderr: string }> {
  return execFileAsync('git', args, { cwd })
}
