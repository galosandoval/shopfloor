/**
 * The IO shell for the terminal state (shopfloor#50): read the attempt trail
 * off the branch, say on the issue that the ceiling is spent, and apply the
 * `exhausted` row.
 *
 * **It runs where the ceiling trips, which is the setup-free admission job** —
 * no checkout, no install, nothing but this package and `gh`. That is why the
 * trail is read through the contents API rather than off disk: the process that
 * *knows* the ceiling is spent is the one that was never given a working tree,
 * and paying for a full runner to write one label and one comment is the cost
 * the ceiling exists to stop.
 *
 * **This is the one write admission's job makes, and the exception is narrow.**
 * `runAdmission` still writes nothing on any verdict, and this is not part of
 * it: a caller reads the verdict and calls this on the `exhausted` refusal.
 * What makes it safe where a labelling refusal would not be is that the
 * ceiling is derived from history **this package wrote** — the
 * `agent:in-progress` additions its own runs made — and it is only reached
 * after classification admitted a real trigger and, on the human edge, the
 * spend gate admitted the actor. There is no drive-by path to it.
 *
 * **Nothing here throws.** The loop has already ended by the time this runs;
 * a report that failed to post must not turn a terminal state into a crashed
 * job, and the reason it failed is on the result for the caller to print.
 */

import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { runLabelVocabularyCheck } from '../guardrails/run-label-vocabulary'
import { applyLabelTransition } from '../issue-state/apply-transition'
import {
  commentOnIssueBestEffort,
  type IssueRef
} from '../issue-state/issue-comment'
import { resolveAttemptsDir } from '../orchestration/config'
import { asExecFailure, describeExecFailure } from '../process/exec-failure'
import type { SpentCeiling } from '../trigger/admission'
import { buildExhaustionReport, type TrailDocument } from './exhaustion'

const execFileAsync = promisify(execFile)

/**
 * Where a committed trail is, as `gh api` needs to be told it. The four travel
 * together through every read below — a directory with no branch to read it at
 * names a path on whatever the API defaults to, which is the wrong attempt's
 * story or none.
 */
interface TrailLocation {
  repo: string
  branch: string
  attemptsDir: string
  /** Only for `gh` to run in; no checkout is required or assumed. */
  cwd: string | undefined
}

export interface ReportExhaustionInput {
  /** The refusal's own facts — see {@link SpentCeiling}. */
  ceiling: SpentCeiling
  /** Where the trail is committed. Defaults to `ATTEMPTS_DIR`, else the package's. */
  attemptsDir?: string
  /** Defaults to `process.env`. */
  env?: NodeJS.ProcessEnv
  /** Only for `gh` to run in; no checkout is required or assumed. */
  cwd?: string
}

export interface ReportExhaustionResult {
  /** Whether the trail was posted on the issue. */
  reported: boolean
  /** Whether `agent:exhausted` was applied. */
  transitioned: boolean
  /** How many attempt documents were read off the branch. */
  attemptsRead: number
  /**
   * How many of them the comment carried — fewer than {@link attemptsRead}
   * when the trail did not fit one comment, and zero when nothing was posted.
   */
  attemptsPosted: number
  /** Why a step did not happen — nothing here throws, so something has to say. */
  detail?: string
}

/**
 * Land the terminal state for a spent ceiling.
 *
 * The order is the comment first and the transition second, the same ordering
 * the closure block uses one level down and for the same reason: the transition
 * is a `gh` call that can fail, and the comment holds the only account of *why*
 * the loop stopped that a human sees on the issue. A lost label leaves an issue
 * mislabelled; a lost comment leaves `agent:exhausted` with nothing behind it.
 */
export async function reportExhaustion(
  input: ReportExhaustionInput
): Promise<ReportExhaustionResult> {
  const { ceiling } = input
  const env = input.env ?? process.env
  const trail = await readTrail({
    repo: ceiling.repo,
    branch: ceiling.branch,
    // The same resolution a run makes, from the one place it is written down:
    // a trail written to one directory and read from another is an empty
    // comment on an issue that has one.
    attemptsDir: resolveAttemptsDir(input.attemptsDir, env),
    cwd: input.cwd
  })

  const report = buildExhaustionReport({
    ...ceiling,
    trail: trail.documents,
    ...(trail.detail ? { trailUnavailable: trail.detail } : {})
  })

  if (!report.report) {
    return {
      reported: false,
      transitioned: false,
      attemptsRead: trail.documents.length,
      attemptsPosted: 0,
      detail: report.reason
    }
  }

  const issue = { issueNumber: String(ceiling.issueNumber), repo: ceiling.repo }
  // **The vocabulary is checked before the comment, not after.** Reporting once
  // is enforced by the `agent:exhausted` label being there next time, so a
  // repository that cannot carry the label is a repository where every later
  // event on the branch trips the same ceiling and posts the whole trail again
  // — the comment generator this module exists to avoid, reached by the one
  // failure that is both permanent and knowable in advance. So a *refused*
  // vocabulary writes nothing and says why. An unreadable one is a different
  // answer and keeps the old behaviour: not knowing is not the same as knowing
  // the label is missing, and a terminal state nobody reported is worse than a
  // comment that might repeat.
  const vocabulary = await checkVocabulary(issue, input.cwd)

  if (vocabulary.refused) {
    return {
      reported: false,
      transitioned: false,
      attemptsRead: trail.documents.length,
      attemptsPosted: 0,
      detail: vocabulary.reason
    }
  }

  const reported = await commentOnIssueBestEffort(
    issue,
    report.comment,
    'the spent attempt ceiling'
  )

  const transitioned = await applyExhaustedRow(issue, ceiling.currentLabels)
  // Every half can fail on its own, and each one alone is worth printing — a
  // detail that overwrote another would report the last thing to go wrong
  // rather than what went wrong.
  const detail = [trail.detail, vocabulary.reason, transitioned.detail]
    .filter(Boolean)
    .join('; ')

  return {
    reported,
    transitioned: transitioned.transitioned,
    attemptsRead: trail.documents.length,
    attemptsPosted: reported ? report.attemptsPosted : 0,
    ...(detail ? { detail } : {})
  }
}

/**
 * The vocabulary check every caller of {@link applyLabelTransition} in this
 * package makes — a transition written against labels a repository does not
 * carry is the rotted binding shopfloor#45 exists to eliminate. Unlike a run,
 * this one **reports** a missing vocabulary rather than throwing on it: the run
 * it would have failed is already over.
 *
 * A check that could not run is deliberately not a refusal. See the call site
 * for why the two answers part company here and nowhere else.
 */
async function checkVocabulary(
  issue: IssueRef,
  cwd: string | undefined
): Promise<{ refused: boolean; reason: string }> {
  try {
    const vocabulary = await runLabelVocabularyCheck({
      repo: issue.repo,
      cwd: cwd ?? process.cwd()
    })

    return vocabulary.refused
      ? { refused: true, reason: vocabulary.reason }
      : { refused: false, reason: '' }
  } catch (error) {
    return { refused: false, reason: String(error) }
  }
}

/** Apply the `exhausted` row, the vocabulary already checked. */
async function applyExhaustedRow(
  issue: IssueRef,
  currentLabels: readonly string[]
): Promise<{ transitioned: boolean; detail?: string }> {
  try {
    // The labels the refusal was made against, rather than a second read: the
    // report and the state it lands are then about one snapshot of the issue,
    // and an edit made between the two cannot make them disagree.
    await applyLabelTransition({
      ...issue,
      outcome: 'exhausted',
      currentLabels: [...currentLabels]
    })
    return { transitioned: true }
  } catch (error) {
    return { transitioned: false, detail: String(error) }
  }
}

/**
 * The trail as the branch carries it, read through `gh api` rather than off
 * disk — see the module doc.
 *
 * Oldest first, by filename: the files are named by CI run id, which GitHub
 * hands out in increasing order, so a lexicographic sort of same-width ids is
 * chronological. Ordering the story wrong would be worse than the sort being
 * approximate — each document states its own attempt number, so a reader is
 * never left inferring it from position.
 */
async function readTrail(
  input: TrailLocation
): Promise<{ documents: TrailDocument[]; detail?: string }> {
  let paths: string[]

  try {
    paths = await listTrail(input)
  } catch (error) {
    // **A 404 is not a fault, and everything else is.** An empty directory is a
    // 404 here, and so is a branch that never carried one — indistinguishable,
    // and both mean "no trail", which the comment already states plainly. Only
    // the ordinary first-attempt-exhausted case reaches this at all, so
    // reporting it as evidence lost would put "part of the trail could not be
    // read" on the most-read comment the loop writes, for a trail that never
    // existed. A broken token or an unreadable repository still says so.
    return isNotFound(error)
      ? { documents: [] }
      : {
          documents: [],
          detail: describeExecFailure(
            error,
            `could not list ${input.attemptsDir} on ${input.branch}`
          )
        }
  }

  const documents: TrailDocument[] = []
  const failures: string[] = []

  for (const path of paths) {
    try {
      documents.push({ path, document: await readFile(input, path) })
    } catch (error) {
      failures.push(`${path} (${describeExecFailure(error, 'unreadable')})`)
    }
  }

  return failures.length > 0
    ? { documents, detail: `could not read ${failures.join(', ')}` }
    : { documents }
}

/**
 * Whether `gh api` failed because the path is not there, rather than because
 * something is wrong. Matched on what `gh` prints — `gh: Not Found (HTTP 404)`
 * — because the exit code is 1 for every API failure it has, so the code alone
 * cannot tell an absent directory from a revoked token.
 */
function isNotFound(error: unknown): boolean {
  const { stderr } = asExecFailure(error)
  return /\b404\b/.test(stderr) || /not found/i.test(stderr)
}

async function listTrail(input: TrailLocation): Promise<string[]> {
  const listed = await gh(
    [
      'api',
      `repos/${input.repo}/contents/${input.attemptsDir}?ref=${input.branch}`,
      '--jq',
      '.[] | select(.type == "file") | .path'
    ],
    input.cwd
  )

  return listed
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .sort()
}

/**
 * One document. The contents API answers base64 with newlines in it, which is
 * why this decodes rather than asking `gh` for raw text: the raw media type
 * needs a header flag, and a decode this package can see is a decode it can
 * test.
 */
async function readFile(input: TrailLocation, path: string): Promise<string> {
  const encoded = await gh(
    [
      'api',
      `repos/${input.repo}/contents/${path}?ref=${input.branch}`,
      '--jq',
      '.content'
    ],
    input.cwd
  )

  return Buffer.from(encoded.replace(/\s/g, ''), 'base64').toString('utf8')
}

async function gh(args: string[], cwd: string | undefined): Promise<string> {
  const { stdout } = await execFileAsync('gh', args, cwd ? { cwd } : {})
  return stdout
}
