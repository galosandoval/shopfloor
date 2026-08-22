/**
 * The success path's half of the handoff (shopfloor#49): remove the whole trail
 * and commit the removal.
 *
 * Separate from `run-handoff.ts` because the two change for different reasons —
 * one assembles a document out of five optional probes, this one deletes files.
 * What they share is the commit identity, and that lives in `git.ts`.
 *
 * **Nothing here throws**, for the reason the write does not: bookkeeping that
 * fails must not replace the outcome actually worth reporting.
 */

import { commitPaths, git, type AttemptsTrailLocation } from './git'

export interface StripAttemptsResult {
  stripped: boolean
  /** How many attempt files were removed. */
  removed: number
  detail?: string
}

/**
 * Remove the whole trail and commit the removal — in the commit the successful
 * run is about to push, so the strip rides out with the work rather than in a
 * follow-up push.
 *
 * **All of them, and only on success.** They are kept on the exhausted terminal
 * state, where the PR stays open and the trail is the best account of what went
 * wrong that anyone has; design §4 posts it as the comment. A run that merely
 * failed keeps them too, because the next attempt is the whole reason they were
 * written.
 */
export async function stripAttempts(
  input: AttemptsTrailLocation
): Promise<StripAttemptsResult> {
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
