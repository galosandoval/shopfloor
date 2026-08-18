/**
 * The one place the `agent/issue-<n>` branch convention is written down
 * (shopfloor#46).
 *
 * It lives here rather than beside the classification because both edges of
 * the loop need it and they need it in opposite directions: the human edge
 * **builds** the branch from an issue number so the attempt ceiling knows
 * which runs to count, and the machine edge **parses** an issue number back
 * out of `workflow_run.head_branch`, which is the only place a finished CI run
 * says which issue it belongs to. A convention read one way in one file and
 * written the other way in another is two conventions with a shared prefix.
 *
 * Package-owned, and that is a change: the live consumer's YAML generated the
 * name with a `tr`/`sed`/`cut` pipeline. Design §6 already declined to make
 * that name decisive for anything, precisely because a consumer can change it;
 * owning it here is what lets the count be taken against a branch the harness
 * itself will create when the one verb (design §2) lands.
 */

/**
 * The prefix design §6 uses as its cheap pre-filter on the machine edge. A
 * failed CI run on any other branch is somebody's own work, and the loop has
 * no business retriggering on it.
 */
export const AGENT_BRANCH_PREFIX = 'agent/issue-'

/**
 * The branch a phase run for `issueNumber` works on. Exact, with nothing
 * appended: a slug carries the issue title, which a human can edit after the
 * branch exists, and a name that has to be re-derived from mutable prose is
 * the binding shape this design keeps eliminating.
 */
export function agentBranchForIssue(issueNumber: number): string {
  return `${AGENT_BRANCH_PREFIX}${issueNumber}`
}

/** Built from the prefix above so the two can never disagree. */
const BRANCH_PATTERN = new RegExp(`^${AGENT_BRANCH_PREFIX}(\\d+)(?:-.*)?$`)

/**
 * The issue a branch belongs to, or undefined when the branch is not the
 * harness's.
 *
 * **Tolerant where it reads, exact where it writes.** It accepts a trailing
 * slug (`agent/issue-46-classify-trigger`) because a branch created by the
 * consumer's old `sed` pipeline, or by a human following the convention by
 * hand, still names its issue unambiguously — and the alternative is a machine
 * edge that goes quiet on branches everybody can see belong to the loop. What
 * it will not do is guess: a suffix that is not `-`-separated
 * (`agent/issue-46x`) is a different branch, not a slugged one.
 */
export function issueNumberFromBranch(branch: string): number | undefined {
  const match = BRANCH_PATTERN.exec(branch.trim())
  const issueNumber = match ? Number(match[1]) : NaN
  return Number.isSafeInteger(issueNumber) && issueNumber > 0
    ? issueNumber
    : undefined
}
