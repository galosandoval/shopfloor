import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { buildVerifyComment } from './verify-comment'

const execFileAsync = promisify(execFile)

export interface PostVerifyCommentInput {
  issueNumber: string
  /** `owner/repo`, e.g. `galosandoval/shopfloor`. */
  repo: string
  prNumber: string
  /** Commit SHA the screenshots were pushed at. */
  sha: string
  runUrl: string
  /** Path to the agent's verify report (markdown). */
  verifyReportFile: string
  /** Repo-relative dir holding the committed `*.png` screenshots. */
  screenshotsDir: string
  /**
   * Where to stage the comment body before posting via `gh pr comment
   * --body-file`. Defaults to a file under the OS tmpdir.
   */
  commentFile?: string
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
 * Best-effort by contract: verify never blocks the PR, so any failure here is
 * caught and returned rather than thrown. Raw URLs are pinned to `sha` (the
 * commit that still has the files), not a branch name, so they keep
 * resolving after a later commit strips the screenshots off the branch tip.
 */
export async function postVerifyComment(
  input: PostVerifyCommentInput
): Promise<PostVerifyCommentResult> {
  try {
    const report = readReport(input.verifyReportFile, input.issueNumber)
    const screenshots = listScreenshots(input.screenshotsDir)

    const body = buildVerifyComment({
      report,
      repo: input.repo,
      ref: input.sha,
      screenshots,
      runUrl: input.runUrl
    })

    const commentFile =
      input.commentFile ??
      path.join(os.tmpdir(), `verify-comment-${input.issueNumber}.md`)
    fs.writeFileSync(commentFile, body)

    await execFileAsync('gh', [
      'pr',
      'comment',
      input.prNumber,
      '--repo',
      input.repo,
      '--body-file',
      commentFile
    ])

    return { posted: true, screenshotCount: screenshots.length }
  } catch (error) {
    return { posted: false, screenshotCount: 0, error }
  }
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
