/**
 * The outer loop's terminal state (shopfloor#50, design §4): what a spent
 * attempt ceiling says on the issue.
 *
 * **`agent:exhausted`, never `agent:blocked`.** They are the two failures with
 * the most different human responses in the system — *fix the issue's shape*
 * versus *the work is harder than specified, or the spec is wrong* — and
 * collapsing them discards the most expensive signal the harness produces. The
 * transition table already holds the row; what was missing was anything that
 * applied it when the ceiling tripped, since the ceiling trips in admission,
 * before a run exists to have an outcome.
 *
 * **The comment is the trail, because the trail is already written.** Each
 * attempt committed a handoff to the branch; the alternative to posting them is
 * a human opening N commits to reconstruct what the harness already knows. The
 * documents are reproduced rather than summarized, for the reason the handoff's
 * two halves never blend: a summary of the agent's claims would be the harness
 * restating an unreliable narrator as fact.
 *
 * **It reports once, and that is a decision rather than an optimization.** A
 * stateless edge trips the same ceiling on every later event — every CI run
 * that fails on the branch, every re-label. The issue's own `agent:exhausted`
 * label is what says the report already happened, and reading it is what keeps
 * the loop from turning a terminal state into a comment generator.
 *
 * Pure: facts in, a comment or a reason not to out. Reading the trail off the
 * branch and writing either is `run-exhaustion.ts`.
 */

import { EXHAUSTED_LABEL } from '../issue-state/vocabulary'
import type { SpentCeiling } from '../trigger/admission'

/** One attempt's committed handoff, as read back off the branch. */
export interface TrailDocument {
  /** Repo-relative path, so the comment can say where the whole of it lives. */
  path: string
  document: string
}

/**
 * The refusal's own facts, plus the evidence read off the branch.
 *
 * It **extends** {@link SpentCeiling} rather than restating its fields: the two
 * were the same clump copied across a module boundary, so a new ceiling fact
 * meant editing the refusal, this input, and the shell that unpacked one into
 * the other. Extending costs a type-only import from a module that is pure
 * either way.
 */
export interface ExhaustionReportInput extends SpentCeiling {
  /** The trail, oldest attempt first. Empty is a fact the comment states. */
  trail: readonly TrailDocument[]
  /**
   * Why the trail is missing or partial. Present alongside a trail that was
   * read, since a fetch can fail for one file out of three, and a comment that
   * showed two and said nothing would read as an issue with two attempts.
   */
  trailUnavailable?: string
}

export type ExhaustionReport =
  | { report: false; reason: string }
  | {
      report: true
      comment: string
      /**
       * How many attempt documents the comment actually carries. Reported
       * rather than left to the caller's count of what it *read*: the two
       * differ whenever the trail did not fit, and a shell that printed the
       * larger number would say it posted evidence nobody can see.
       */
      attemptsPosted: number
    }

/**
 * The comment a spent ceiling posts, or why this event posts none.
 *
 * The PR is deliberately not mentioned as something to close: it stays open,
 * because closing it discards partial work and attempt N usually got most of
 * the way. Nothing here strips the trail either — the trail is the evidence
 * this comment is made of.
 */
export function buildExhaustionReport(
  input: ExhaustionReportInput
): ExhaustionReport {
  if (input.currentLabels.includes(EXHAUSTED_LABEL)) {
    return {
      report: false,
      reason:
        `Issue #${input.issueNumber} is already labeled "${EXHAUSTED_LABEL}", ` +
        'so the ceiling has been reported. Every later event on the branch ' +
        'trips the same ceiling, and a terminal state that comments each time ' +
        'is a comment generator rather than a terminal state.'
    }
  }

  return renderExhaustionComment(input)
}

/**
 * How much of the trail one comment carries. GitHub's own body limit is 65536
 * characters; this leaves room for the heading above the documents and stops
 * the loop's last act from being a post that failed on a length nobody chose.
 */
export const EXHAUSTION_COMMENT_LIMIT = 60_000

function renderExhaustionComment(
  input: ExhaustionReportInput
): Extract<ExhaustionReport, { report: true }> {
  const head = renderHead(input)
  const { kept, dropped } = fitTrail(
    input.trail,
    // Floored at zero rather than trusted to be positive: the head is prose
    // this file writes and is nowhere near the limit today, but a budget that
    // went negative would reach `cutToFit` and post a comment whose entire
    // trail section was the note saying it had been cut.
    Math.max(
      0,
      EXHAUSTION_COMMENT_LIMIT - head.join('\n').length - TRAIL_SECTION_FRAME
    )
  )

  return {
    report: true,
    comment: [...head, ...trailSection(input, kept, dropped)].join('\n'),
    attemptsPosted: kept.length
  }
}

/** Everything above the trail — the part of the comment that is not evidence. */
function renderHead(input: ExhaustionReportInput): string[] {
  return [
    `## The attempt ceiling is spent — ${input.attempts} of ` +
      `${input.maxAttempts} runs`,
    '',
    `No further run starts on issue #${input.issueNumber} by itself. That the ` +
      'ceiling was reached rather than the gate passed means the work is ' +
      'harder than the spec said, or the spec is wrong — either way the next ' +
      "move is a human's.",
    '',
    `The branch \`${input.branch}\` and its pull request are left as they are: ` +
      'nothing is closed, and the attempt trail below is still committed on ' +
      'the branch.',
    '',
    // **What recovery is, stated exactly.** Re-labelling the issue is the
    // obvious guess and it does not work: the count is every
    // `agent:in-progress` addition the issue's timeline ever recorded, which no
    // later edit clears, so the next event trips the same ceiling — and
    // silently, since this label is what stops it commenting twice. Naming a
    // recovery that cannot happen would send a human round that loop once per
    // issue.
    'Another run is a deliberate decision, not a re-label: raise the ceiling ' +
      '(`shopfloor-admit --max-attempts <n>`, and the same value on the run) ' +
      'for an issue worth paying more for. Re-labelling alone will not do it — ' +
      "the count is the issue's permanent timeline of runs, which no edit " +
      'rewrites.',
    '',
    '---',
    ''
  ]
}

function trailSection(
  input: ExhaustionReportInput,
  kept: readonly TrailDocument[],
  dropped: number
): string[] {
  const missing = input.trailUnavailable
    ? [
        `Part of the trail could not be read (${input.trailUnavailable}), so ` +
          'what follows may not be every attempt.',
        ''
      ]
    : []

  if (kept.length === 0) {
    return [
      '### The attempt trail',
      '',
      ...missing,
      `No handoff documents were found on \`${input.branch}\`. The runs' own ` +
        'logs are the account of them.'
    ]
  }

  return [
    '### The attempt trail',
    '',
    ...missing,
    ...(dropped > 0
      ? [
          `The ${dropped === 1 ? 'oldest attempt is' : `${dropped} oldest attempts are`} ` +
            `omitted to fit one comment; ${dropped === 1 ? 'it is' : 'they are'} ` +
            `committed on \`${input.branch}\` in full.`,
          ''
        ]
      : []),
    ...kept.flatMap((attempt) => [
      `#### \`${attempt.path}\``,
      '',
      attempt.document,
      ''
    ])
  ]
}

/**
 * As much of the trail as one comment holds, **dropping from the oldest end**.
 *
 * The last attempt is the one that reached the ceiling and the one a human
 * reads first, so it is the last thing to lose. A cut that dropped the newest
 * would leave the most expensive comment in the loop describing a state two
 * attempts out of date.
 */
function fitTrail(
  trail: readonly TrailDocument[],
  budget: number
): { kept: readonly TrailDocument[]; dropped: number } {
  const kept: TrailDocument[] = []

  for (const attempt of [...trail].reverse()) {
    const cost = attempt.document.length + attempt.path.length + DOCUMENT_FRAME

    if (cost > budget) {
      // The newest attempt is never dropped for being long — it is the one the
      // ceiling was reached on. It is cut instead, keeping its head, where the
      // harness-authored facts are, and saying that it was cut.
      //
      if (kept.length === 0) kept.unshift(cutToFit(attempt, budget))
      break
    }

    budget -= cost
    kept.unshift(attempt)
  }

  return { kept, dropped: trail.length - kept.length }
}

/** What a document's own heading and blank lines cost around it. */
const DOCUMENT_FRAME = 16

/**
 * What the trail section's own prose costs — its heading, and the two notes it
 * may carry about attempts that were dropped or could not be read. Reserved
 * rather than measured because those notes are written *from* the fit this
 * budget decides, and a limit that depended on its own outcome would be a limit
 * only when it happened to agree with itself.
 */
const TRAIL_SECTION_FRAME = 400

/** One document, cut to what is left of the budget, saying that it was cut. */
function cutToFit(attempt: TrailDocument, budget: number): TrailDocument {
  const note = `\n\n[truncated: the whole document is committed at ${attempt.path}]`
  const room = Math.max(
    0,
    budget - attempt.path.length - note.length - DOCUMENT_FRAME
  )

  return { ...attempt, document: `${attempt.document.slice(0, room)}${note}` }
}
