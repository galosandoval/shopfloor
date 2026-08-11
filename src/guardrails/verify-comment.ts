/**
 * Pure helpers for the agent verify phase (ported from recipe-chat-v1's
 * `agent/implement/verify-comment.ts`, #523): turn a committed-screenshots
 * list + branch + repo into the markdown issue comment a caller posts. No
 * `gh`, filesystem, or Playwright calls live here — that IO is in
 * {@link postVerifyComment}, exactly as {@link runPreflight} wraps the pure
 * `preflight.ts`.
 */

export interface VerifyCommentInput {
  /** The agent's verify report (markdown), or a fallback note when absent. */
  report: string
  /** `owner/repo`, e.g. `galosandoval/shopfloor`. */
  repo: string
  /**
   * Commit SHA the screenshots were pushed at. Pinned to the commit (not the
   * branch name) so the raw URLs keep resolving after a later commit strips
   * the screenshots off the branch tip.
   */
  ref: string
  /**
   * Repo-relative paths of the committed screenshots, e.g.
   * `.agent/verify/issue-5/recipes.png`. Empty for non-UI / skipped runs.
   */
  screenshots: string[]
  /**
   * URL of the workflow run, linked so the PR comment jumps to the full logs.
   * Omitted for a run with no workflow behind it (a local run), which drops
   * the link rather than emitting a dead one.
   */
  runUrl?: string
}

/**
 * Builds a `raw.githubusercontent.com` URL for a committed file so the image
 * renders inline in the PR comment. Each path/ref segment is percent-encoded
 * while the slashes are preserved.
 */
function rawUrl(repo: string, ref: string, filePath: string): string {
  const encode = (segmented: string) =>
    segmented.split('/').map(encodeURIComponent).join('/')
  return `https://raw.githubusercontent.com/${repo}/${encode(ref)}/${encode(filePath)}`
}

/**
 * Assembles the full PR-comment body: the agent's verify report, an inline
 * image for each committed screenshot (raw URLs pinned to `ref`), and a link
 * to the workflow run when there is one. With no screenshots (non-UI /
 * skipped / failed-capture runs) the report and run link stand alone.
 */
export function buildVerifyComment(input: VerifyCommentInput): string {
  const { report, repo, ref, screenshots, runUrl } = input

  const parts = [report.trim() || '_No verify report was produced._']

  if (screenshots.length > 0) {
    const images = screenshots.map((file) => {
      const name = file.split('/').pop() ?? file
      return `![${name}](${rawUrl(repo, ref, file)})`
    })
    parts.push(`### Screenshots\n\n${images.join('\n\n')}`)
  }

  if (runUrl) {
    parts.push(`[View the workflow run](${runUrl})`)
  }

  return `${parts.join('\n\n')}\n`
}
