import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import {
  evaluatePreflight,
  parseClosingReferences,
  type LinkingPullRequest,
  type PreflightVerdict
} from './preflight'

const execFileAsync = promisify(execFile)

export interface RunPreflightInput {
  issueNumber: string
  /** `owner/repo`, e.g. `galosandoval/shopfloor`. */
  repo: string
}

export interface RunPreflightResult {
  verdict: PreflightVerdict
}

/**
 * IO wrapper for the pre-flight refusal gate (ported from recipe-chat-v1's
 * `agent/implement/run-preflight.ts`, #511): gathers the labeled issue's
 * native parent/sub-issue links and the open PRs targeting it via `gh`, asks
 * {@link evaluatePreflight} for a verdict, and on refusal drops the
 * `agent:implement` label for `agent:blocked` and posts an explanatory
 * comment. Callers own any CI-specific glue (e.g. writing a
 * `$GITHUB_OUTPUT` line, exiting the job) based on the returned verdict.
 */
export async function runPreflight(
  input: RunPreflightInput
): Promise<RunPreflightResult> {
  const issue = await ghJson<{
    parent: { number: number } | null
    subIssues: { totalCount: number }
  }>([
    'issue',
    'view',
    input.issueNumber,
    '--repo',
    input.repo,
    '--json',
    'parent,subIssues'
  ])

  const subIssueCount = issue.subIssues?.totalCount ?? 0
  const parentNumber = issue.parent?.number ?? null

  // Every open PR in the repo, scanned below for closing keywords that target
  // this issue. GitHub recognises closing keywords in a PR's body.
  const openPullRequests = await ghJson<
    Array<{ number: number; title: string; body: string | null; url: string }>
  >([
    'pr',
    'list',
    '--repo',
    input.repo,
    '--state',
    'open',
    // Generous so a busy repo doesn't silently truncate the scan.
    '--limit',
    '200',
    '--json',
    'number,title,body,url'
  ])

  const issueNumber = Number(input.issueNumber)
  const linkingPullRequests: LinkingPullRequest[] = openPullRequests
    .filter((pr) =>
      parseClosingReferences(`${pr.title ?? ''}\n${pr.body ?? ''}`).includes(
        issueNumber
      )
    )
    .map((pr) => ({ number: pr.number, url: pr.url }))

  const verdict = evaluatePreflight({
    subIssueCount,
    parentNumber,
    linkingPullRequests
  })

  if (verdict.refused) {
    // Refuse before any work: drop the go/spend label, flag blocked, explain why.
    await gh([
      'issue',
      'edit',
      input.issueNumber,
      '--repo',
      input.repo,
      '--remove-label',
      'agent:implement',
      '--add-label',
      'agent:blocked'
    ])
    await gh([
      'issue',
      'comment',
      input.issueNumber,
      '--repo',
      input.repo,
      '--body',
      `\`agent:implement\` refused before starting.\n\n**Reason:** ${verdict.reason}\n\nFix the above and re-add \`agent:implement\` to retry.`
    ])
  }

  return { verdict }
}

async function gh(args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('gh', args)
  return stdout
}

/** Run `gh` and parse its stdout as JSON, typed by the caller via `T`. */
async function ghJson<T>(args: string[]): Promise<T> {
  return JSON.parse(await gh(args)) as T
}
