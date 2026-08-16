/**
 * The run's side of the label vocabulary (shopfloor#45): **verify and refuse,
 * never create.**
 *
 * The design's §8 had the harness create the missing labels at startup, weighed
 * against zero-setup installs. Once `shopfloor init` exists that alternative is
 * gone, so the durable write to a shared human workspace happens at a moment a
 * human asked for it, and a run only checks. Nothing is lost by the reversal:
 * the *verification* is what makes a transition onto a label that does not
 * exist impossible, not the creation.
 *
 * Pure — {@link runLabelVocabularyCheck} runs `gh label list` and hands the
 * names over.
 */

import { REQUIRED_LABELS } from '../issue-state/vocabulary'

export interface LabelVocabularyInput {
  /**
   * Every label name the repository has, or `'unknown'` when `gh label list`
   * could not be read.
   */
  repoLabels: readonly string[] | 'unknown'
}

export type LabelVocabularyVerdict =
  | { refused: false }
  | { refused: true; reason: string; missing: readonly string[] }

/**
 * Whether the repository carries the vocabulary this run's transitions are
 * written against.
 *
 * **An unreadable probe refuses too, and the reason names it as unreadable.**
 * That is stricter than the doctor, which reports the same fact as `unknown`
 * and passes — deliberately, and for the reason the two differ everywhere
 * else in this package: a diagnostic tolerates its own blind spots, a gate on
 * spend does not. The direction that costs least is the refusal. Proceeding
 * buys a whole agent run whose closing transition then fails against a
 * repository nobody checked; refusing costs one re-run, before a token is
 * spent. The verdict still keeps *unreadable* apart from *missing*, because
 * `gh` being unauthenticated and a repository being unconfigured are different
 * things to go fix.
 */
export function evaluateLabelVocabulary(
  input: LabelVocabularyInput
): LabelVocabularyVerdict {
  if (input.repoLabels === 'unknown') {
    return {
      refused: true,
      missing: [],
      reason:
        "The repository's labels could not be read (`gh label list`), so the " +
        'run cannot verify the label vocabulary its issue transitions are ' +
        'written against. Check `gh auth status` and the repository, then ' +
        'retry.'
    }
  }

  const present = new Set(input.repoLabels)
  const missing = REQUIRED_LABELS.filter((label) => !present.has(label))
  if (missing.length === 0) return { refused: false }

  return {
    refused: true,
    missing,
    reason:
      `The repository is missing ${missing.length} of the ` +
      `${REQUIRED_LABELS.length} labels this run transitions over: ` +
      `${missing.join(', ')}. Run \`shopfloor init\` to create them. A ` +
      'transition onto a label that does not exist fails rather than ' +
      'happening, which is how one of these had never once fired.'
  }
}
