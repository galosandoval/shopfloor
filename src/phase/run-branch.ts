/**
 * The harness's branch (shopfloor#47): locate it or create it, and push what
 * the run committed onto it.
 *
 * **Why the harness owns this at all.** A retrigger lands on a branch that
 * already exists, so the loop has to *find* it to iterate; something located on
 * every loop edge is already owned, and leaving creation outside means two
 * components computing the same branch identity — which is what the consumer's
 * `tr`/`sed`/`cut` slug pipeline was. The identity itself is
 * {@link agentBranchForIssue} and is written down in exactly one place.
 *
 * All shell, no decision: which branch this is, is `branch.ts`.
 */

import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { agentBranchForIssue } from '../trigger/branch'

const execFileAsync = promisify(execFile)

export interface EnsureAgentBranchInput {
  issueNumber: number
  /** Where `git` runs — the checkout the caller's CI already made. */
  cwd: string
  /** Defaults to `origin`. */
  remote?: string
}

export interface EnsureAgentBranchResult {
  branch: string
  /**
   * False when the branch was found rather than made — the retrigger case, and
   * the one a second creation would break by starting the work over.
   */
  created: boolean
}

/**
 * Check out `agent/issue-<n>`, creating it only if nothing has it yet.
 *
 * The remote is preferred over a local branch of the same name, because the
 * remote is where the previous attempt's commits are and a CI runner's local
 * copy is whatever `actions/checkout` happened to fetch. `checkout -B` against
 * the fetched head is what makes a retrigger continue the branch instead of
 * forking a stale one beside it — and it moves no ref the harness does not own,
 * since the name is the harness's by construction.
 */
export async function ensureAgentBranch(
  input: EnsureAgentBranchInput
): Promise<EnsureAgentBranchResult> {
  const branch = agentBranchForIssue(input.issueNumber)
  const remote = input.remote ?? 'origin'
  const git = (...args: string[]) =>
    execFileAsync('git', args, { cwd: input.cwd })

  if (await remoteHasBranch(input.cwd, remote, branch)) {
    await git('fetch', remote, branch)
    await git('checkout', '-B', branch, 'FETCH_HEAD')
    return { branch, created: false }
  }

  if (await localHasBranch(input.cwd, branch)) {
    await git('checkout', branch)
    return { branch, created: false }
  }

  await git('checkout', '-b', branch)
  return { branch, created: true }
}

/**
 * Push the branch, so the PR has something to open against and the machine
 * edge has a head commit to be attributed to.
 *
 * Never forced: `classifyCommand` blocks the agent from rewriting history, and
 * the harness holds itself to the rule it enforces. `--set-upstream` is
 * harmless on a branch that already tracks and is what makes the first push of
 * a new one work.
 */
export async function pushAgentBranch(input: {
  branch: string
  cwd: string
  remote?: string
}): Promise<void> {
  await execFileAsync(
    'git',
    ['push', '--set-upstream', input.remote ?? 'origin', input.branch],
    { cwd: input.cwd }
  )
}

/** The commit the run left at the branch tip — what verify's screenshots are pinned to. */
export async function headSha(cwd: string): Promise<string | undefined> {
  try {
    const { stdout } = await execFileAsync('git', ['rev-parse', 'HEAD'], {
      cwd
    })
    return stdout.trim() || undefined
  } catch {
    return undefined
  }
}

async function remoteHasBranch(
  cwd: string,
  remote: string,
  branch: string
): Promise<boolean> {
  try {
    const { stdout } = await execFileAsync(
      'git',
      ['ls-remote', '--heads', remote, branch],
      { cwd }
    )
    return stdout.trim().length > 0
  } catch {
    // A remote that cannot be reached is not a remote that says no. The branch
    // check below still answers, and a push that has no remote fails later
    // naming the remote rather than here naming a branch.
    return false
  }
}

async function localHasBranch(cwd: string, branch: string): Promise<boolean> {
  try {
    await execFileAsync(
      'git',
      ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`],
      { cwd }
    )
    return true
  } catch {
    return false
  }
}
