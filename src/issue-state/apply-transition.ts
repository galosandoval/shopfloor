/**
 * The `gh` half of the issue state machine (shopfloor#45): read what the issue
 * is labeled with, ask {@link evaluateLabelTransition} where it should be, and
 * write the difference. Every decision is next door in `transition.ts`; this
 * file only moves bytes across the process boundary.
 */

import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import {
  evaluateLabelTransition,
  type LabelTransition,
  type RunOutcome
} from './transition'

const execFileAsync = promisify(execFile)

export interface ApplyLabelTransitionInput {
  issueNumber: string
  /** `owner/repo`, e.g. `galosandoval/shopfloor`. */
  repo: string
  outcome: RunOutcome
  /**
   * What the issue carries now. Optional: a caller that already read the
   * issue passes them and spends no second `gh` call, and one that has not
   * lets this probe. Stated or probed, the transition is computed from real
   * labels rather than assumed — the assumption is what rotted last time.
   */
  currentLabels?: readonly string[]
}

export interface ApplyLabelTransitionResult {
  transition: LabelTransition
  /** False when the issue was already in the target state and nothing was written. */
  applied: boolean
}

/**
 * Apply the transition for `outcome`. A no-op delta writes nothing at all,
 * which is what makes applying the same outcome twice — two workflow runs
 * landing on the same event, a retried job — cost one read and no write.
 *
 * Both edits go in a single `gh issue edit`, so an issue is never briefly
 * carrying neither the old state nor the new one for another run to read.
 *
 * It does not swallow a `gh` failure. The step this replaces ended in
 * `|| true`, and that is precisely how a transition onto a label that did not
 * exist went unnoticed for the life of the pipeline; the run's own startup
 * verification (`runLabelVocabularyCheck`) is what makes that failure
 * unreachable, and a thrown error is what keeps it that way if it ever becomes
 * reachable again.
 */
export async function applyLabelTransition(
  input: ApplyLabelTransitionInput
): Promise<ApplyLabelTransitionResult> {
  const currentLabels =
    input.currentLabels ??
    (await readIssueLabels(input.issueNumber, input.repo))

  const transition = evaluateLabelTransition({
    currentLabels,
    outcome: input.outcome
  })

  if (transition.add.length === 0 && transition.remove.length === 0) {
    return { transition, applied: false }
  }

  await execFileAsync('gh', [
    'issue',
    'edit',
    input.issueNumber,
    '--repo',
    input.repo,
    ...transition.remove.flatMap((label) => ['--remove-label', label]),
    ...transition.add.flatMap((label) => ['--add-label', label])
  ])

  return { transition, applied: true }
}

/** The issue's labels, by name. */
async function readIssueLabels(
  issueNumber: string,
  repo: string
): Promise<string[]> {
  const { stdout } = await execFileAsync('gh', [
    'issue',
    'view',
    issueNumber,
    '--repo',
    repo,
    '--json',
    'labels',
    '-q',
    '.labels[].name'
  ])
  return stdout.split('\n').filter(Boolean)
}
