/**
 * Pure readiness check on the prompt a run is about to spawn with
 * (shopfloor#44). Two failures, and neither produced an error anywhere before
 * this: a prompt still carrying the scaffolder's `TODO(shopfloor)` sentinel,
 * and a `{{TOKEN}}` nothing substitutes — which rendered as literal text,
 * unchanged and unreported, so an unfilled placeholder was indistinguishable
 * from prose. Both spend a run's tokens and then fail on a command the
 * repository does not have.
 *
 * No IO here — {@link runImplementAgent} calls it among the preconditions,
 * before any probe runs and before the CLI spawns.
 *
 * **It judges the template, not the rendered prompt.** On tokens the two are
 * the same verdict — rendering only ever removes tokens the table knows, so an
 * unrecognized one survives it untouched — and checking beforehand is what
 * lets the refusal land ahead of the `git` and `gh` probes. On the sentinel
 * they differ, in the direction that keeps the loop running: a sentinel (or a
 * `{{...}}`) arriving inside a substituted _value_, an issue title say, is the
 * issue's data rather than a defect in the consumer's prompt, and refusing
 * over it would let any issue's own prose block the loop.
 */

import { ENVIRONMENT_UNFILLED_SENTINEL } from '../setup/setup'

export interface PromptReadinessInput {
  /** The prompt text as the run holds it, before substitution. */
  prompt: string
  /**
   * Every token substitution renders, and only those — `PROMPT_TOKENS` for
   * this package's own runs. A parameter rather than an import so the check
   * cannot drift from the table the caller actually renders with.
   */
  knownTokens: readonly string[]
}

export type PromptReadinessVerdict =
  { refused: false } | { refused: true; reason: string }

/**
 * Any identifier-shaped `{{ TOKEN }}`, inner whitespace and all. Deliberately
 * wider than what substitution matches (`{{TOKEN}}`, nothing else): a spaced
 * or lowercased one is a token *nothing renders*, which is the failure this
 * refuses on rather than a form to quietly permit. Prose that happens to sit
 * in braces — `{{ two words }}` — is not identifier-shaped and is left alone.
 */
const TOKEN_PATTERN = /\{\{\s*[\w-]+\s*\}\}/g

/**
 * Refuses a prompt that was scaffolded and never filled, or that names a token
 * nothing renders. The reason names every offender and what should replace it,
 * because a refusal a consumer has to bisect for is one they learn to work
 * around.
 */
export function evaluatePromptReadiness(
  input: PromptReadinessInput
): PromptReadinessVerdict {
  const problems = [
    describeSentinel(input.prompt),
    describeUnknownTokens(input.prompt, input.knownTokens)
  ].filter((problem) => problem !== undefined)

  if (problems.length === 0) return { refused: false }

  return {
    refused: true,
    reason: `Refusing to spawn: the prompt is not filled in. ${problems.join(' ')}`
  }
}

/**
 * The sentinel's lines, or nothing when it is absent. Line numbers rather than
 * a count: the block is filled by hand, and the operator's next move is opening
 * the file at the line.
 */
function describeSentinel(prompt: string): string | undefined {
  const lines = prompt
    .split('\n')
    .flatMap((line, index) =>
      line.includes(ENVIRONMENT_UNFILLED_SENTINEL) ? [index + 1] : []
    )
  if (lines.length === 0) return undefined

  return (
    `It still carries ${ENVIRONMENT_UNFILLED_SENTINEL} on ` +
    `${lines.length === 1 ? 'line' : 'lines'} ${lines.join(', ')} — replace ` +
    "each with this repository's own value, the one `shopfloor init` could " +
    'not read off it.'
  )
}

/**
 * The occurrences substitution will not render, each named once in the order
 * they first appear and quoted exactly as the prompt writes them — spaces
 * included, since `{{ ISSUE_NUMBER }}` and `{{ISSUE_NUMBER}}` differ by the one
 * thing the operator has to see. Nothing when every occurrence renders.
 */
function describeUnknownTokens(
  prompt: string,
  knownTokens: readonly string[]
): string | undefined {
  const renders = new Set(knownTokens.map(braced))
  const unknown = [...new Set(prompt.match(TOKEN_PATTERN) ?? [])].filter(
    (occurrence) => !renders.has(occurrence)
  )
  if (unknown.length === 0) return undefined

  const one = unknown.length === 1
  return (
    `Nothing substitutes ${unknown.join(', ')}, so ` +
    `${one ? 'it' : 'they'} would reach the agent as literal text — remove ` +
    `${one ? 'it' : 'them'} or use one of ` +
    `${knownTokens.map(braced).join(', ')}.`
  )
}

function braced(token: string): string {
  return `{{${token}}}`
}
