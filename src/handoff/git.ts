/**
 * The two commits the handoff makes, and the one rule both obey (shopfloor#49).
 *
 * **They are authored as the agent, deliberately.** The machine edge is keyed on
 * the head commit's author (`AGENT_COMMIT_AUTHOR`, design §6), and these commits
 * land on top of the agent's own before the push. A handoff committed under the
 * runner's ambient identity would make the head commit somebody else's work, and
 * the retrigger this artifact exists to inform would never fire. `--no-verify`
 * for the same class of reason: a consumer's pre-commit hook failing is not a
 * reason to lose the one record of why the attempt failed.
 *
 * Shared by the write and the strip because the identity is the *contract*, not
 * a convenience — two copies would be two places for it to drift out of the one
 * name `classifyTrigger` checks.
 */

import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { AGENT_COMMIT_AUTHOR } from '../trigger/classify'

const execFileAsync = promisify(execFile)

/** The email half of the identity above — what `git -c user.email` is given. */
const AGENT_COMMIT_EMAIL = `${AGENT_COMMIT_AUTHOR}@users.noreply.github.com`

/**
 * Where the trail lives, for the two shells that read and write it. The pair
 * travels together everywhere it appears — a directory with no repository to
 * resolve it against names nothing.
 */
export interface AttemptsTrailLocation {
  /** Repo-relative directory the trail is committed under. */
  attemptsDir: string
  cwd: string
}

export function git(
  cwd: string,
  args: string[]
): Promise<{ stdout: string; stderr: string }> {
  return execFileAsync('git', args, { cwd })
}

/**
 * Commit exactly these paths, as the agent, skipping the consumer's hooks.
 *
 * Path-limited rather than a bare `git commit -a`: whatever else is in the
 * working tree belongs to the agent's own commits, and sweeping it into a
 * bookkeeping commit would attribute work to a message about a handoff.
 *
 * It stages nothing — each caller has already staged what it is committing, and
 * for different reasons: the write path `add`s a file git has never seen, while
 * the strip's `git rm` stages its own deletion and leaves a pathspec that
 * matches nothing anywhere.
 *
 * **No paths means an empty commit, deliberately** (shopfloor#50). The loop's
 * closing mark has to be on the head commit whether or not there was a trail to
 * strip, and a pathspec matching nothing would fail the commit rather than
 * making an empty one. The pathspec is dropped in that case for the same
 * reason: `git commit --allow-empty -- <nothing>` is not a command.
 */
export async function commitPaths(
  cwd: string,
  paths: string[],
  message: string
): Promise<{ committed: boolean; detail?: string }> {
  try {
    await git(cwd, [
      '-c',
      `user.name=${AGENT_COMMIT_AUTHOR}`,
      '-c',
      `user.email=${AGENT_COMMIT_EMAIL}`,
      'commit',
      '--no-verify',
      ...(paths.length === 0 ? ['--allow-empty'] : []),
      '-m',
      message,
      ...(paths.length === 0 ? [] : ['--', ...paths])
    ])
    return { committed: true }
  } catch (error) {
    return { committed: false, detail: String(error) }
  }
}
