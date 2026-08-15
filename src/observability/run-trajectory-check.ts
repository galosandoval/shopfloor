import * as fs from 'node:fs'
import {
  checkTrajectory,
  formatScorecard,
  type TranscriptEvent,
  type TrajectoryFinding
} from './trajectory'

export interface RunTrajectoryCheckInput {
  /** The captured session transcript (JSONL), as written by transcript capture. */
  transcriptFile: string
  /** The run policy's turn cap, for the budget invariant. */
  maxTurns: number
  /** Overrides the checker's default headroom fraction. */
  headroomFraction?: number
  /** Overrides the checker's default gate-run patterns for this repository. */
  gateCommandPatterns?: readonly RegExp[]
  /**
   * Where to write the rendered scorecard, for a caller that posts it with
   * `gh … --body-file` or uploads it. Omitted, nothing is written and the
   * markdown is only returned.
   */
  scorecardFile?: string
}

export interface RunTrajectoryCheckResult {
  /** False when there was no transcript to read at all. */
  graded: boolean
  /** Empty when `graded` is false. */
  findings: TrajectoryFinding[]
  /** The rendered markdown, or null when `graded` is false. */
  scorecard: string | null
  /** Set when a swallowed failure kept the run from completing a step. */
  error?: unknown
}

/**
 * The IO shell around the trajectory checker: read the captured transcript,
 * hand the parsed events to the pure {@link checkTrajectory}, render the
 * scorecard, and write it out when the caller named a file. Gather → decide →
 * act, with every side effect on this side of the seam.
 *
 * **Never throws, never fails a run.** The scorecard is observability: a
 * missing or unreadable transcript degrades to `graded: false`, an unwritable
 * scorecard file to an attached `error`, and neither is a reason to take down a
 * run that otherwise committed. Findings are advisory — this returns them, it
 * does not act on them.
 */
export function runTrajectoryCheck(
  input: RunTrajectoryCheckInput
): RunTrajectoryCheckResult {
  const events = readTranscript(input.transcriptFile)
  if (events === null) {
    return { graded: false, findings: [], scorecard: null }
  }

  const findings = checkTrajectory(events, {
    maxTurns: input.maxTurns,
    headroomFraction: input.headroomFraction,
    gateCommandPatterns: input.gateCommandPatterns
  })
  const scorecard = formatScorecard(findings)

  if (input.scorecardFile === undefined) {
    return { graded: true, findings, scorecard }
  }
  try {
    fs.writeFileSync(input.scorecardFile, `${scorecard}\n`)
    return { graded: true, findings, scorecard }
  } catch (error) {
    return { graded: true, findings, scorecard, error }
  }
}

/**
 * One parsed record per line, or null when there is no readable transcript. A
 * line that fails to parse is dropped rather than fatal: a run killed by a
 * runaway guard leaves a truncated final line, and that transcript still grades
 * — as a thinner one — instead of yielding no scorecard at all.
 */
function readTranscript(file: string): TranscriptEvent[] | null {
  let raw: string
  try {
    raw = fs.readFileSync(file, 'utf8')
  } catch {
    return null
  }

  const events: TranscriptEvent[] = []
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue
    try {
      events.push(JSON.parse(line))
    } catch {
      // A truncated final line or a stray non-JSON line thins the transcript;
      // checkTrajectory grades whatever survives.
    }
  }
  return events
}
