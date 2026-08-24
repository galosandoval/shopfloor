/**
 * The handoff artifact (shopfloor#49, design §5 and review finding 4): the one
 * thing an attempt leaves behind for the next one to read.
 *
 * **Why it is load-bearing rather than a nicety.** Every run starts cold. A
 * bounded loop over identical attempts is not a feedback loop, it is a token
 * incinerator with a stop button — without memory, iteration N+1 re-derives the
 * same wrong approach and spends the ceiling doing it.
 *
 * **Two authors, never blended.** The harness-authored half is observed fact:
 * the CI failure that triggered this edge, the trajectory scorecard, the run id,
 * the diff. The agent-authored half is marked as *claims* — what it tried, what
 * it abandoned, what it believes went wrong. An agent that just failed is the
 * least reliable narrator of why, and a self-authored postmortem is exactly the
 * fluent-but-wrong artifact the harness exists to catch; pure harness
 * authorship, though, throws away the one thing only the agent knows and that
 * nothing can recover from a transcript at any reasonable cost. So both, in
 * sections a reader can tell apart at a glance.
 *
 * **Everything here is bounded, and the bounds are constants rather than
 * judgement.** Unbounded logs are how a handoff becomes context rot one
 * iteration at a time, and the trail is read in full by every later attempt —
 * so the cost of an unbounded section is paid once per remaining attempt, not
 * once.
 *
 * Pure: facts in, markdown out. Gathering them — the `gh` log fetch, the
 * scorecard, the diff, the agent's claims file — and committing the result is
 * `run-handoff.ts`.
 */

import type { FailedPhaseOutcome } from '../issue-state/transition'
import type {
  TrajectoryFinding,
  TrajectoryStatus
} from '../observability/trajectory'
import type { RunUsage } from '../observability/usage'

/**
 * Where the trail lives, repo-relative and **committed** — which deliberately
 * breaks the derive-don't-store rule the attempt ceiling sets (design §4). The
 * distinction is the justification: the run count is a *fact* and gets derived
 * from the issue timeline, while the handoff is a *synthesis* that cannot be
 * re-derived deterministically. Re-deriving it would mean re-summarizing the
 * same failure into different prose on every read.
 */
export const DEFAULT_ATTEMPTS_DIR = '.agent/attempts'

/** Bounded tail of the failing CI logs, in characters. */
export const HANDOFF_LOG_TAIL_LIMIT = 4000

/** Bound on the committed diff summary, in characters. */
export const HANDOFF_DIFF_LIMIT = 2000

/** Bound on the agent's own claims, in characters. */
export const HANDOFF_CLAIMS_LIMIT = 4000

/**
 * The two headings, exported because they are the contract: a reader — human or
 * agent — tells fact from claim by which one it is under, and a test that
 * asserted on a copy of the prose would let the two drift.
 */
export const HARNESS_SECTION_HEADING = '## Harness — observed facts'

export const AGENT_SECTION_HEADING =
  '## Agent — claims (unverified, written by the attempt that failed)'

/**
 * The CI failure that triggered this attempt, on the machine edge. A failed
 * fetch degrades to URL-only rather than blocking the loop — the same direction
 * every other observability path in this package fails in — but it says so,
 * because "no logs" and "logs that said nothing" are different things for the
 * next attempt to read.
 */
export interface HandoffCiFailure {
  runUrl: string
  /**
   * Bounded here as well as by the caller; see {@link HANDOFF_LOG_TAIL_LIMIT}.
   * The shell bounds it *while fetching* — a job log large enough to defeat a
   * read is exactly the run whose tail is worth having — and this is the
   * backstop for anyone rendering a document from logs they gathered
   * themselves.
   */
  logTail?: string
  /**
   * How long the logs were before the shell kept a tail of them, when it had to.
   * Absent means `logTail` is the whole of them. Stated rather than implied: a
   * tail that silently stands in for a much longer log reads as a short log, and
   * the next attempt would draw conclusions from a beginning that was never
   * there.
   */
  logTotalChars?: number
  /** Why there is no tail. Present exactly when `logTail` is absent. */
  logUnavailable?: string
}

/**
 * What the attempt changed, or the reason nobody could say. Split from
 * {@link HandoffInput} because the shell answers both halves in one probe, and
 * a `diffStat` that is absent because the diff *failed* is a different fact
 * from one that is absent because nothing was committed — rendering the two the
 * same is how "nothing changed" gets asserted on no evidence.
 */
export interface HandoffDiff {
  /** `git diff --stat` against the base — what the attempt actually changed. */
  diffStat?: string
  /** Why there is none. */
  diffUnavailable?: string
}

export interface HandoffInput extends HandoffDiff {
  /**
   * The CI run that produced this attempt. Named by run id rather than by a
   * sequence number: once the ceiling is derived from the issue timeline a
   * sequence number has no job left except to disagree with the real count, and
   * the run id links straight back to the logs and the transcript.
   */
  runId: string
  attempt: number
  maxAttempts: number
  issueNumber: number
  branch: string
  /** This attempt's own CI run, when the environment named one. */
  runUrl?: string
  /**
   * How the attempt ended. A successful run writes no handoff at all: the trail
   * is stripped at that point, so writing one would mean the same commit adding
   * and removing a file.
   */
  outcome: FailedPhaseOutcome
  /** How the attempt ended, in the harness's words — the error it threw. */
  failure: string
  ciFailure?: HandoffCiFailure
  /**
   * The trajectory scorecard for this attempt, when one was graded. Absent is
   * reported as absent rather than rendered as a clean sheet: an ungraded
   * attempt read as a passing one is the walk-past the closure condition
   * already refuses one level down.
   */
  scorecard?: readonly TrajectoryFinding[]
  /**
   * What the attempt spent, when it got far enough to spawn anything
   * (shopfloor#50). The ceiling bounds attempts and the cost argument is in
   * tokens, so the trail is where the two meet: a maintainer deciding whether
   * to raise the ceiling is deciding whether to pay for another attempt this
   * size, and the exhausted terminal state posts these documents at exactly
   * that moment. Absent means nothing spawned — a precondition refusal — which
   * is a spend of nothing rather than an unknown.
   */
  usage?: RunUsage
  /** The agent's own account, verbatim. */
  claims?: string
  /**
   * Why there is none, used only when `claims` is absent — the shell answers
   * both in one pass rather than deciding which to send, so a claims file that
   * turned out to hold something wins over the reason it might not have.
   */
  claimsUnavailable?: string
}

/**
 * Render one attempt's handoff.
 *
 * The harness half comes first and is always present, including for a run
 * killed by a runaway guard or one that crashed — those are precisely the runs
 * the attempt ceiling exists to stop, and precisely the ones that would
 * otherwise teach the next iteration nothing. Only the agent's claims are
 * legitimately unavailable there, and the document **says so** rather than
 * quietly omitting the section: a missing section reads as an attempt that had
 * nothing to say, which is a different and wrong story.
 */
export function renderHandoff(input: HandoffInput): string {
  return [
    `# Attempt ${input.attempt} of ${input.maxAttempts} — run \`${input.runId}\``,
    '',
    `Issue #${input.issueNumber} on \`${input.branch}\`. The attempt ended ` +
      `**${input.outcome}**.`,
    ...(input.runUrl ? ['', `Run log: ${input.runUrl}`] : []),
    '',
    'Two authors, never blended. Everything under "Harness" is a fact this ' +
      'package observed. Everything under "Agent" is the failed attempt\'s own ' +
      'account of itself, and is unverified.',
    '',
    HARNESS_SECTION_HEADING,
    '',
    `**How it ended.** ${input.failure}`,
    '',
    ...ciFailureSection(input.ciFailure),
    ...spendSection(input.usage),
    ...scorecardSection(input.scorecard),
    ...diffSection(input),
    AGENT_SECTION_HEADING,
    '',
    ...claimsSection(input)
  ].join('\n')
}

/** `<run-id>.md`, with a run id that is not one kept inside the directory. */
export function attemptFileName(runId: string): string {
  const safe = runId
    .replace(/[^A-Za-z0-9_-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')

  return `${safe || 'unknown-run'}.md`
}

function ciFailureSection(failure: HandoffCiFailure | undefined): string[] {
  if (!failure) {
    return [
      '### The CI failure that triggered this attempt',
      '',
      'None — this attempt was started by a human rather than by a failed CI ' +
        'run.',
      ''
    ]
  }

  return [
    '### The CI failure that triggered this attempt',
    '',
    failure.runUrl,
    '',
    ...(failure.logTail
      ? fenced(ciLogTail(failure.logTail, failure.logTotalChars), 'text')
      : [
          `The failing logs could not be fetched (${failure.logUnavailable ?? 'no reason given'}), ` +
            'so the run URL above is all this attempt has of them.'
        ]),
    ''
  ]
}

/**
 * The log tail, saying so whenever it is one.
 *
 * Two cuts can have happened by here and the document has to survive both: the
 * shell keeps a rolling tail while fetching, because a log too large to read is
 * exactly the run worth reading the end of, and {@link bounded} is the backstop
 * for a caller that gathered its own. Either way the note is what matters — an
 * unannounced tail reads as a short log.
 */
function ciLogTail(logTail: string, logTotalChars: number | undefined): string {
  const droppedAtFetch = (logTotalChars ?? 0) > logTail.length
  const tail = bounded(logTail, HANDOFF_LOG_TAIL_LIMIT, 'tail')

  return droppedAtFetch
    ? `[truncated while fetching: kept the last ${logTail.length} of ${logTotalChars} characters]\n${tail}`
    : tail
}

/**
 * What the attempt cost, and how well the number is known.
 *
 * **`source` is stated rather than smoothed over** (shopfloor#42): an
 * `observed` total is not a total, and the one reading it exists to prevent is
 * a killed run's partial count taken as its price. The line the ceiling's
 * argument rests on has to say which of the two it is, or the argument rests on
 * a number nobody can size.
 */
function spendSection(usage: RunUsage | undefined): string[] {
  const heading = ['### What the attempt spent', '']

  if (!usage) {
    return [
      ...heading,
      'Nothing — the attempt failed before it spawned anything.',
      ''
    ]
  }

  const cost =
    usage.costUsd === undefined ? '' : `, $${usage.costUsd.toFixed(2)}`

  return [
    ...heading,
    `${tokens(usage.inputTokens)} in · ${tokens(usage.outputTokens)} out · ` +
      `${tokens(usage.cacheCreationInputTokens)} cache-write · ` +
      `${tokens(usage.cacheReadInputTokens)} cache-read${cost}`,
    '',
    usage.source === 'reported'
      ? "Reported by the CLI itself — this is the attempt's whole spend."
      : 'Observed by the harness rather than reported by the CLI, because the ' +
        'attempt never reached its final tally. Output is a floor; input and ' +
        'cache-read overcount, since every turn restates the conversation.',
    ''
  ]
}

function tokens(count: number): string {
  return count.toLocaleString('en-US')
}

function scorecardSection(
  scorecard: readonly TrajectoryFinding[] | undefined
): string[] {
  if (!scorecard || scorecard.length === 0) {
    return [
      '### Trajectory scorecard',
      '',
      'This attempt was never graded — read that as no evidence either way, ' +
        'not as a clean sheet.',
      ''
    ]
  }

  return ['### Trajectory scorecard', '', ...scorecard.map(describeFinding), '']
}

const STATUS_MARK: Record<TrajectoryStatus, string> = {
  pass: '✅',
  fail: '❌',
  'not-evaluable': '⚪'
}

/**
 * One finding per line, **with its id**. The id is what the next attempt can
 * name back at the harness — the closure condition gates on ids, and a
 * scorecard rendered as prose alone would make the one thing a later attempt
 * has to act on the one thing it has to guess at.
 */
function describeFinding(finding: TrajectoryFinding): string {
  const turns = finding.evidence
    .map((evidence) => `turn ${evidence.turnIndex}`)
    .join(', ')

  return (
    `- ${STATUS_MARK[finding.status]} **${finding.title}** (\`${finding.id}\`) — ` +
    `${finding.detail}${turns ? ` (${turns})` : ''}`
  )
}

function diffSection(diff: HandoffDiff): string[] {
  const heading = ['### What the attempt changed', '']

  if (diff.diffUnavailable) {
    return [...heading, `Undetermined — ${diff.diffUnavailable}.`, '']
  }

  if (!diff.diffStat?.trim()) {
    return [...heading, 'Nothing was committed.', '']
  }

  return [
    ...heading,
    ...fenced(bounded(diff.diffStat, HANDOFF_DIFF_LIMIT, 'head'), 'text'),
    ''
  ]
}

/**
 * The agent's half, **quoted rather than reproduced**.
 *
 * Every line is prefixed, which is not decoration: without it an agent that
 * writes `## Harness — observed facts` into its own claims would forge the
 * section the next attempt is supposed to trust, and the whole authorship split
 * would come apart on prose the harness does not control. Quoting makes that
 * structurally impossible while leaving the text readable and verbatim.
 */
function claimsSection(input: HandoffInput): string[] {
  if (!input.claims?.trim()) {
    return [
      `None — ${input.claimsUnavailable ?? 'the attempt wrote none'}. The ` +
        'harness half above is complete regardless; only this section depends ' +
        'on the agent having survived to write it.'
    ]
  }

  return [
    'Quoted verbatim from the agent, and unverified — treat every sentence as ' +
      'something the last attempt *believed*.',
    '',
    ...quoted(bounded(input.claims, HANDOFF_CLAIMS_LIMIT, 'head'))
  ]
}

function quoted(text: string): string[] {
  return text.split('\n').map((line) => (line ? `> ${line}` : '>'))
}

function fenced(text: string, language: string): string[] {
  // A fence longer than anything inside it, so content carrying its own fences
  // cannot end the block early.
  const longest = Math.max(
    3,
    ...[...text.matchAll(/`{3,}/g)].map((match) => match[0].length + 1)
  )
  const fence = '`'.repeat(longest)

  return [`${fence}${language}`, text, fence]
}

/**
 * `text`, cut to `limit` characters, keeping the end (`tail`) or the start
 * (`head`) and saying which — a silent truncation reads as a short log, and the
 * next attempt would draw conclusions from an ending that was never there.
 *
 * Logs keep their tail because a failure lands at the end of them; a diff
 * summary and an agent's own account keep their head, because both are written
 * most-important-first.
 */
function bounded(text: string, limit: number, keep: 'head' | 'tail'): string {
  if (text.length <= limit) return text

  const note = `[truncated: kept the ${keep === 'tail' ? 'last' : 'first'} ${limit} of ${text.length} characters]`

  return keep === 'tail'
    ? `${note}\n${text.slice(-limit)}`
    : `${text.slice(0, limit)}\n${note}`
}
