/**
 * The success path's half of the handoff (shopfloor#49, extended by
 * shopfloor#50): end the loop on this branch — remove the attempt trail if
 * there is one, and mark the commit that did it as the one that closed the
 * loop.
 *
 * **Both halves are one commit deliberately.** The mark has to be on the head
 * commit, because that is all a `workflow_run` payload carries; and a run that
 * succeeded on its first attempt has no trail to strip, so a commit made only
 * when there was one would leave the common success with no mark at all —
 * exactly the case shopfloor#50 exists to exclude, reached by the more likely
 * path. So the commit is made either way, empty when there is nothing to
 * delete, and it is the only commit in this package with no file content of its
 * own.
 *
 * Separate from `run-handoff.ts` because the two change for different reasons —
 * one assembles a document out of five optional probes, this one ends a branch.
 * What they share is the commit identity, and that lives in `git.ts`.
 *
 * **Nothing here throws**, for the reason the write does not: bookkeeping that
 * fails must not replace the outcome actually worth reporting.
 */

import { LOOP_CLOSED_TRAILER } from '../trigger/classify'
import { commitPaths, git, type AttemptsTrailLocation } from './git'

export interface CloseLoopResult {
  /**
   * Whether the closing commit landed. False means the branch's head is an
   * ordinary agent commit, so a CI failure on it will read as another attempt.
   */
  closed: boolean
  /** How many attempt files were removed — zero on a first-attempt success. */
  removed: number
  detail?: string
}

/**
 * Close the loop on this branch, in the commit the successful run is about to
 * push — so it rides out with the work rather than in a follow-up push.
 *
 * **The trail is stripped only here, and only on success.** It is kept on the
 * exhausted terminal state, where the PR stays open and the trail is the best
 * account of what went wrong that anyone has (design §4 posts it as the
 * comment), and kept on an ordinary failure, because the next attempt is the
 * whole reason it was written.
 */
export async function closeLoop(
  input: AttemptsTrailLocation
): Promise<CloseLoopResult> {
  const tracked = await trackedAttempts(input)

  if (tracked.length > 0) {
    try {
      await git(input.cwd, ['rm', '-r', '--quiet', '--', input.attemptsDir])
    } catch (error) {
      return { closed: false, removed: 0, detail: String(error) }
    }
  }

  const commit = await commitPaths(
    input.cwd,
    // Path-limited when there is a trail; empty when there is not, which is
    // what makes `commitPaths` allow an empty commit rather than fail on a
    // pathspec matching nothing.
    tracked.length > 0 ? [input.attemptsDir] : [],
    `chore(shopfloor): close the loop on this branch${
      tracked.length > 0 ? ' — the run succeeded, trail stripped' : ''
    }\n\n${LOOP_CLOSED_TRAILER}\n`
  )

  return {
    closed: commit.committed,
    removed: commit.committed ? tracked.length : 0,
    detail: commit.detail
  }
}

/** The attempt files git already has — what there is to strip, if anything. */
async function trackedAttempts(
  input: AttemptsTrailLocation
): Promise<string[]> {
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
