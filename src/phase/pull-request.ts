/**
 * What the pull request the harness opens says (shopfloor#47) — pure, so the
 * one thing about a PR that is a decision rather than a `gh` call can be read
 * and tested on its own. Locating or opening it is `run-pull-request.ts`.
 *
 * The whole of the decision is: the PR must close its issue exactly once, and
 * the agent's own description is the body. Both matter more than they look.
 * The closing reference is what `evaluatePreflight` reads to refuse a second
 * run on an issue that already has a PR, so a PR that carries none makes that
 * guard blind — and a *second* one, appended over a description that already
 * says `Closes #47`, is the duplicate GitHub then lists twice on the issue.
 */

import { parseClosingReferences } from '../guardrails/preflight'

export interface PullRequestFieldsInput {
  issueNumber: number
  /** The issue's own title — the PR is named after the work, not the branch. */
  issueTitle: string
  /**
   * What the agent wrote to `prDescriptionFile`. Empty is tolerated rather
   * than refused: `runImplementAgent` already falls back to a one-line
   * description rather than discarding finished commits, and a PR body is not
   * where a run should be failed.
   */
  description: string
}

export interface PullRequestFields {
  title: string
  body: string
}

/** The title and body of the PR a phase opens for its issue. */
export function buildPullRequestFields(
  input: PullRequestFieldsInput
): PullRequestFields {
  const description = input.description.trim()
  const closes = `Closes #${input.issueNumber}`
  const alreadyCloses = parseClosingReferences(description).includes(
    input.issueNumber
  )

  return {
    title: `${input.issueTitle} (#${input.issueNumber})`,
    body: alreadyCloses
      ? `${description}\n`
      : `${description ? `${description}\n\n` : ''}${closes}\n`
  }
}
