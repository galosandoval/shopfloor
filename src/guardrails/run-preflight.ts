import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { applyLabelTransition } from '../issue-state/apply-transition'
import { ENTRY_LABEL } from '../issue-state/vocabulary'
import { ImplementAgentError } from '../orchestration/implement-error'
import {
  evaluatePreflight,
  parseClosingReferences,
  type LinkingPullRequest,
  type PreflightVerdict
} from './preflight'
import { runLabelVocabularyCheck } from './run-label-vocabulary'

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
 * {@link evaluatePreflight} for a verdict, and on refusal applies the
 * `refused` row of the issue-state transition table
 * ({@link applyLabelTransition}) and posts an explanatory comment. Callers own
 * any CI-specific glue (e.g. writing a
 * `$GITHUB_OUTPUT` line, exiting the job) based on the returned verdict.
 *
 * It verifies the label vocabulary first — see {@link requireLabelVocabulary}.
 */
export async function runPreflight(
  input: RunPreflightInput
): Promise<RunPreflightResult> {
  await requireLabelVocabulary(input.repo)

  const issue = await ghJson<{
    parent: { number: number } | null
    subIssues: { totalCount: number }
    labels: Array<{ name: string }>
  }>([
    'issue',
    'view',
    input.issueNumber,
    '--repo',
    input.repo,
    '--json',
    // `labels` rides along on the read the refusal already needed, so the
    // transition below computes its delta from real labels without a second
    // round trip.
    'parent,subIssues,labels'
  ])

  const subIssueCount = issue.subIssues?.totalCount ?? 0
  const parentNumber = issue.parent?.number ?? null
  const currentLabels = (issue.labels ?? []).map((label) => label.name)

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
    // Refuse before any work: move the issue to the state the table gives a
    // refusal, then explain why. The labels are no longer literals here —
    // this shell owned the package's first issue-state transition, written as
    // two strings, and shopfloor#45 moved that decision into the table where
    // it can be read beside every other transition and changed in one place.
    const { transition } = await applyLabelTransition({
      issueNumber: input.issueNumber,
      repo: input.repo,
      outcome: 'refused',
      currentLabels
    })
    await gh([
      'issue',
      'comment',
      input.issueNumber,
      '--repo',
      input.repo,
      '--body',
      refusalComment(verdict.reason, transition.add)
    ])
  }

  return { verdict }
}

/**
 * Refuse before any of this shell's own work when the repository does not carry
 * the labels the transition below is written against (shopfloor#45).
 *
 * `runPreflight` is a public entry point in its own right — `runImplementAgent`
 * never calls it, and a CI job runs it as its own step — so it does not inherit
 * the run's startup verification. Without this, the one transition the package
 * applies today would be applied from the one path that skipped the check that
 * makes applying it safe: exactly the rotted binding this table exists to
 * eliminate, on exactly the code that used to carry the label literals.
 *
 * It throws rather than returning a refused {@link PreflightVerdict}, because
 * the two say different things. A verdict means *this issue* must not be
 * implemented, and the caller answers it by labelling the issue — which is the
 * write that cannot be trusted here. A missing vocabulary is the repository
 * being unconfigured; there is nothing to label, and the job should fail
 * naming what to run.
 *
 * `gh` infers nothing from the checkout here: `repo` is stated, so the probe's
 * `cwd` only decides where `gh` runs.
 */
async function requireLabelVocabulary(repo: string): Promise<void> {
  const verdict = await runLabelVocabularyCheck({ repo, cwd: process.cwd() })
  if (verdict.refused) throw new ImplementAgentError(verdict.reason)
}

/**
 * What the refusal tells the human. Every label it names comes from the
 * vocabulary or from the transition just applied, never from a literal — the
 * prose used to say "re-add `agent:implement` to retry", which was wrong twice
 * over: the loop's trigger watches {@link ENTRY_LABEL}, and adding a label the
 * issue still carries fires no `issues.labeled` event at all. A refusal whose
 * instructions do not retrigger the run is the same silently-rotted binding
 * this table exists to eliminate.
 *
 * @param added - The labels the transition put on, so the comment states the
 * state it left behind rather than restating the table from memory.
 */
function refusalComment(reason: string, added: string[]): string {
  const now = added.map((label) => `\`${label}\``).join(' + ')
  return (
    `The implement phase refused this issue before starting.\n\n` +
    `**Reason:** ${reason}\n\n` +
    `The issue is now labelled ${now}. Fix the above and re-add ` +
    `\`${ENTRY_LABEL}\` to retry.`
  )
}

async function gh(args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('gh', args)
  return stdout
}

/** Run `gh` and parse its stdout as JSON, typed by the caller via `T`. */
async function ghJson<T>(args: string[]): Promise<T> {
  return JSON.parse(await gh(args)) as T
}
