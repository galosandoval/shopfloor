/**
 * Pure pre-flight refusal logic (ported from recipe-chat-v1's
 * `agent/implement/preflight.ts`, #511). A leaf-issue-only agent refuses
 * before any work begins when a labeled issue is a PRD (has native
 * sub-issues), is itself a native sub-issue of a parent, or already has an
 * open PR targeting it. No IO here — {@link runPreflight} gathers these
 * inputs via `gh` and acts on the verdict.
 *
 * This keys off GitHub's *native* parent/sub-issue links, not any repo's own
 * textual "## Parent #N" doc convention: a consumer's implementable slices
 * may carry that text while being top-level issues, so refusing on the text
 * alone would block every run.
 */

export interface LinkingPullRequest {
  number: number
  url: string
}

export interface PreflightInput {
  /** Native GitHub sub-issue count; a PRD has at least one. */
  subIssueCount: number
  /** Native GitHub parent issue number, or null for a top-level issue. */
  parentNumber: number | null
  /** Open PRs that already target this issue via a closing keyword. */
  linkingPullRequests: LinkingPullRequest[]
}

export type PreflightVerdict =
  { refused: false } | { refused: true; reason: string }

/** GitHub's issue-closing keywords (every accepted tense/plural form). */
const CLOSING_KEYWORD =
  /\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\b[:\s]+#(\d+)/gi

/**
 * Issue numbers referenced by a GitHub closing keyword in `text`
 * (e.g. "Closes #12", "fixes #3", "Resolves: #4"). Case-insensitive and
 * de-duplicated; non-closing references like "Refs #5" are ignored.
 */
export function parseClosingReferences(text: string): number[] {
  const found = new Set<number>()
  for (const match of text.matchAll(CLOSING_KEYWORD)) {
    found.add(Number(match[1]))
  }
  return [...found]
}

/**
 * Decide whether a labeled leaf issue is safe to implement. Checks are ordered
 * most-specific first so the comment names the strongest reason to refuse.
 */
export function evaluatePreflight(input: PreflightInput): PreflightVerdict {
  if (input.subIssueCount > 0) {
    const plural = input.subIssueCount === 1 ? 'sub-issue' : 'sub-issues'
    return {
      refused: true,
      reason:
        `This issue is a PRD — it has ${input.subIssueCount} ${plural}. ` +
        'The agent implements leaf issues only; label one of its sub-issues ' +
        'instead.'
    }
  }

  if (input.parentNumber !== null) {
    return {
      refused: true,
      reason:
        `This issue is a sub-issue of #${input.parentNumber}. The agent ` +
        'implements leaf issues only; this looks like it is tracked under a ' +
        'parent that should be decomposed first.'
    }
  }

  if (input.linkingPullRequests.length > 0) {
    const list = input.linkingPullRequests
      .map((pr) => `#${pr.number}`)
      .join(', ')
    return {
      refused: true,
      reason:
        `This issue already has an open PR targeting it (${list}). Close or ` +
        'merge it before retrying.'
    }
  }

  return { refused: false }
}
