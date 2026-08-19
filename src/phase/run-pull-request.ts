/**
 * The harness's pull request (shopfloor#47): locate the open one for the
 * branch, or open a draft.
 *
 * Locate-first is not an optimisation. A retrigger runs on a branch whose PR
 * is already open, and a second `gh pr create` against it fails the job on the
 * one edge the outer loop exists to serve; worse, a `|| true` around it — the
 * shape the consumer's YAML used — would hide that the loop was iterating on a
 * PR nobody was reading. What the PR *says* is pure and next door.
 */

import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { buildPullRequestFields } from './pull-request'

const execFileAsync = promisify(execFile)

export interface EnsurePullRequestInput {
  issueNumber: number
  issueTitle: string
  /** `owner/repo`. */
  repo: string
  branch: string
  /** What the agent wrote its PR description to; missing or empty is tolerated. */
  prDescriptionFile: string
  /** Where `gh` runs. */
  cwd: string
  /** Where the body is staged for `--body-file`; defaults beneath the OS tmpdir. */
  bodyFile?: string
}

export interface EnsurePullRequestResult {
  /** The PR's number, as `gh` reports it. */
  number: string
  url: string
  /** False when the run iterated on a PR that was already open. */
  created: boolean
}

/**
 * The open PR for `branch`, opening a draft one if there is none.
 *
 * **Draft, like every PR this harness has ever opened.** The work is
 * unreviewed by construction, and a draft is what says so to the humans the
 * `ready-for-human` transition is about to summon.
 *
 * The body goes through a file rather than `--body`, because it is the agent's
 * prose and an argument list is the wrong place for text of unbounded size.
 */
export async function ensurePullRequest(
  input: EnsurePullRequestInput
): Promise<EnsurePullRequestResult> {
  const existing = await findOpenPullRequest(input)
  if (existing) return { ...existing, created: false }

  const { title, body } = buildPullRequestFields({
    issueNumber: input.issueNumber,
    issueTitle: input.issueTitle,
    description: readDescription(input.prDescriptionFile)
  })

  const bodyFile =
    input.bodyFile ?? path.join(os.tmpdir(), `pr-body-${input.issueNumber}.md`)
  fs.writeFileSync(bodyFile, body)

  const { stdout } = await execFileAsync(
    'gh',
    [
      'pr',
      'create',
      '--repo',
      input.repo,
      '--head',
      input.branch,
      '--draft',
      '--title',
      title,
      '--body-file',
      bodyFile
    ],
    { cwd: input.cwd }
  )

  // `gh pr create` prints the URL it made and nothing else machine-readable,
  // so the number is read back off it rather than parsed out of a second call.
  const url = stdout.trim().split('\n').filter(Boolean).pop() ?? ''
  return { number: url.split('/').pop() ?? '', url, created: true }
}

/** The open PR whose head is this branch, or undefined when there is none. */
async function findOpenPullRequest(
  input: Pick<EnsurePullRequestInput, 'repo' | 'branch' | 'cwd'>
): Promise<{ number: string; url: string } | undefined> {
  const { stdout } = await execFileAsync(
    'gh',
    [
      'pr',
      'list',
      '--repo',
      input.repo,
      '--head',
      input.branch,
      '--state',
      'open',
      '--json',
      'number,url',
      '-q',
      '.[0] | select(.) | "\\(.number)\\t\\(.url)"'
    ],
    { cwd: input.cwd }
  )

  const [number, url] = stdout.trim().split('\t')
  return number ? { number, url: url ?? '' } : undefined
}

/** The agent's description, or an empty string when it wrote none. */
function readDescription(file: string): string {
  try {
    return fs.readFileSync(file, 'utf8')
  } catch {
    return ''
  }
}
