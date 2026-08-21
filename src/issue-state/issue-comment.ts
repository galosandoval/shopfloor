/**
 * The one place this package says something on an issue.
 *
 * Every comment the harness writes is the same `gh issue comment` invocation
 * with a different body — a refusal (`guardrails/run-preflight.ts`), a
 * trajectory block (`phase/run-phase.ts`) — and the argv is the part worth
 * having once: the issue number and `--repo` travel together, and a second
 * copy is a second place for them to drift apart.
 *
 * The two callers differ in what a failed post means, which is why there are
 * two verbs rather than one with a flag. A refusal's comment *is* the refusal
 * reaching the human, so it fails the job; a report on a run that already
 * failed must never replace the failure worth reporting.
 */

import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

/** The issue a run is about, in the shape `gh` and every shell below take it. */
export interface IssueRef {
  issueNumber: string
  /** `owner/repo` — always stated, so `gh` infers nothing from the checkout. */
  repo: string
}

/** Post `body` on the issue, letting a failure out to the caller. */
export async function commentOnIssue(
  issue: IssueRef,
  body: string
): Promise<void> {
  await execFileAsync('gh', [
    'issue',
    'comment',
    issue.issueNumber,
    '--repo',
    issue.repo,
    '--body',
    body
  ])
}

/**
 * The same post, with its own failure reported and then dropped.
 *
 * @param what - Named in the warning, so a swallowed failure says which
 * comment was lost rather than only that one was.
 * @returns Whether it posted.
 */
export async function commentOnIssueBestEffort(
  issue: IssueRef,
  body: string,
  what: string
): Promise<boolean> {
  try {
    await commentOnIssue(issue, body)
    return true
  } catch (error) {
    console.warn(`Could not comment on ${what}: ${String(error)}`)
    return false
  }
}
