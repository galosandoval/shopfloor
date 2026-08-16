/**
 * IO shell for the label-vocabulary refusal (shopfloor#45): list the
 * repository's labels and hand the names to {@link evaluateLabelVocabulary}.
 * The one `gh` call for that decision lives here; `runImplementAgent` acts on
 * the verdict among its preconditions, before a token is spent.
 */

import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import {
  evaluateLabelVocabulary,
  type LabelVocabularyVerdict
} from './label-vocabulary'

const execFileAsync = promisify(execFile)

export interface LabelVocabularyProbe {
  /**
   * `owner/repo`, or undefined to let `gh` infer it from the checkout — the
   * same inference every other `gh` call in this package relies on, and the
   * shape the run's own config has.
   */
  repo: string | undefined
  /** The run's working directory, so that inference reads the right checkout. */
  cwd: string
}

/**
 * Gather and judge.
 *
 * The two fields arrive as one object rather than as two positional strings:
 * they are the same type, so a swapped call site would type-check and probe a
 * directory named `owner/repo`.
 *
 * An unreadable list becomes `'unknown'` rather than an empty one: a
 * repository with no labels and a `gh` that could not answer are different
 * facts, and the pure function refuses on each with a different reason.
 */
export async function runLabelVocabularyCheck(
  probe: LabelVocabularyProbe
): Promise<LabelVocabularyVerdict> {
  return evaluateLabelVocabulary({ repoLabels: await probeLabels(probe) })
}

async function probeLabels({
  repo,
  cwd
}: LabelVocabularyProbe): Promise<string[] | 'unknown'> {
  try {
    const { stdout } = await execFileAsync(
      'gh',
      [
        'label',
        'list',
        ...(repo ? ['--repo', repo] : []),
        // Generous, so a repository with a long label list never truncates
        // into a vocabulary that reads as missing.
        '--limit',
        '200',
        '--json',
        'name',
        '-q',
        '.[].name'
      ],
      { cwd }
    )
    return stdout.split('\n').filter(Boolean)
  } catch {
    return 'unknown'
  }
}
