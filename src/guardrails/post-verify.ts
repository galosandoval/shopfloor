import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { buildVerifyComment } from './verify-comment'

const execFileAsync = promisify(execFile)

export interface PostVerifyCommentInput {
  issueNumber: string
  /** `owner/repo` — defaults to `GITHUB_REPOSITORY`. */
  repo?: string
  /** Defaults to the open PR whose head is `branch`, located via `gh`. */
  prNumber?: string
  /** Commit SHA the screenshots were pushed at — defaults to `GITHUB_SHA`. */
  sha?: string
  /** Defaults to the URL assembled from `GITHUB_SERVER_URL` / `GITHUB_REPOSITORY` / `GITHUB_RUN_ID`. */
  runUrl?: string
  /** Head branch used to locate the PR — defaults to `GITHUB_HEAD_REF`, `GITHUB_REF_NAME`, then the checkout. */
  branch?: string
  /** Path to the agent's verify report (markdown). */
  verifyReportFile: string
  /** Repo-relative dir holding the committed `*.png` screenshots. */
  screenshotsDir: string
  /**
   * Where to stage the comment body before posting via `gh pr comment
   * --body-file`. Defaults to a file under the OS tmpdir.
   */
  commentFile?: string
  /** Defaults to `process.env`. */
  env?: NodeJS.ProcessEnv
  /** Defaults to `process.cwd()` — where the `git` / `gh` probes run. */
  cwd?: string
}

export interface PostVerifyCommentResult {
  posted: boolean
  screenshotCount: number
  /** Set when `posted` is false — the swallowed error, for the caller to log. */
  error?: unknown
}

/**
 * IO wrapper for the verify phase's "post proof to the PR" step (ported from
 * recipe-chat-v1's `agent/implement/post-verify.ts`, #523). Reads the agent's
 * verify report, enumerates the committed screenshots, builds the comment via
 * the pure {@link buildVerifyComment}, and posts it with `gh pr comment`.
 *
 * The repository, commit, and run URL are read from the GitHub Actions
 * environment when unstated, and the PR is located from the head branch via
 * `gh` — so a workflow step restates none of what the runner already exports.
 *
 * Best-effort by contract: verify never blocks the PR, so any failure here —
 * including a value that could not be inferred — is caught and returned rather
 * than thrown. Raw URLs are pinned to `sha` (the commit that still has the
 * files), not a branch name, so they keep resolving after a later commit
 * strips the screenshots off the branch tip.
 */
export async function postVerifyComment(
  input: PostVerifyCommentInput
): Promise<PostVerifyCommentResult> {
  try {
    const env = input.env ?? process.env
    const cwd = input.cwd ?? process.cwd()

    const repo = required(input.repo ?? env.GITHUB_REPOSITORY, 'repo')
    const sha = required(input.sha ?? env.GITHUB_SHA, 'sha')
    const prNumber =
      input.prNumber ??
      (await probePrNumber({ branch: input.branch, env, cwd, repo }))

    const report = readReport(input.verifyReportFile, input.issueNumber)
    const screenshots = listScreenshots(input.screenshotsDir)

    const body = buildVerifyComment({
      report,
      repo,
      ref: sha,
      screenshots,
      runUrl: input.runUrl ?? workflowRunUrl(env)
    })

    const commentFile =
      input.commentFile ??
      path.join(os.tmpdir(), `verify-comment-${input.issueNumber}.md`)
    fs.writeFileSync(commentFile, body)

    await execFileAsync('gh', [
      'pr',
      'comment',
      prNumber,
      '--repo',
      repo,
      '--body-file',
      commentFile
    ])

    return { posted: true, screenshotCount: screenshots.length }
  } catch (error) {
    return { posted: false, screenshotCount: 0, error }
  }
}

/**
 * The workflow run's own URL, assembled from what the GitHub Actions runner
 * already exports, or undefined outside a run — a local invocation gets a
 * comment with no run link rather than a broken one.
 */
function workflowRunUrl(env: NodeJS.ProcessEnv): string | undefined {
  const { GITHUB_SERVER_URL, GITHUB_REPOSITORY, GITHUB_RUN_ID } = env
  if (!GITHUB_REPOSITORY || !GITHUB_RUN_ID) return undefined
  const server = GITHUB_SERVER_URL ?? 'https://github.com'
  return `${server}/${GITHUB_REPOSITORY}/actions/runs/${GITHUB_RUN_ID}`
}

/**
 * A value that had to resolve, named by the field to state when it didn't.
 * Throwing is the reporting channel here: the best-effort contract turns it
 * into `posted: false` with the error attached.
 */
function required(value: string | undefined, field: string): string {
  if (!value) {
    throw new Error(
      `Could not resolve \`${field}\` for the verify comment — pass it explicitly.`
    )
  }
  return value
}

/**
 * The open PR whose head is this run's branch — the comment's target when the
 * caller doesn't name one. Throws when no PR matches, which the caller's
 * best-effort contract turns into an unposted result.
 */
async function probePrNumber(opts: {
  branch: string | undefined
  env: NodeJS.ProcessEnv
  cwd: string
  repo: string
}): Promise<string> {
  const { env, cwd, repo } = opts

  // GITHUB_REF_NAME on a pull_request event is `<number>/merge`, not the head
  // branch, so GITHUB_HEAD_REF comes first.
  const branch =
    opts.branch ??
    env.GITHUB_HEAD_REF ??
    env.GITHUB_REF_NAME ??
    (await probeCurrentBranch(cwd))

  const { stdout } = await execFileAsync(
    'gh',
    [
      'pr',
      'list',
      '--head',
      branch,
      '--repo',
      repo,
      '--state',
      'open',
      '--json',
      'number',
      '-q',
      '.[0].number'
    ],
    { cwd }
  )

  const prNumber = stdout.trim()
  if (!prNumber) {
    throw new Error(`No open PR found for branch ${branch}.`)
  }
  return prNumber
}

async function probeCurrentBranch(cwd: string): Promise<string> {
  const { stdout } = await execFileAsync(
    'git',
    ['rev-parse', '--abbrev-ref', 'HEAD'],
    { cwd }
  )
  return stdout.trim()
}

/** Reads the agent's report, or a fallback note when it is missing/empty. */
function readReport(file: string, issueNumber: string): string {
  try {
    const text = fs.readFileSync(file, 'utf8').trim()
    if (text) return text
  } catch {
    // fall through to the fallback below
  }
  return `Verification did not produce a report for #${issueNumber} — verify manually.`
}

/**
 * Repo-relative paths of the committed `*.png` screenshots, sorted for a
 * stable order. Empty when the dir is absent (non-UI / skipped runs).
 */
function listScreenshots(dir: string): string[] {
  try {
    return fs
      .readdirSync(dir)
      .filter((name) => name.toLowerCase().endsWith('.png'))
      .sort()
      .map((name) => `${dir}/${name}`)
  } catch {
    return []
  }
}
