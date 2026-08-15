import { classifyCommand } from '../guardrails/command-policy'

/**
 * The deterministic trajectory checker: parsed transcript events in, findings
 * out. It grades *how* a run worked, not just what it produced — the agent's
 * session transcript records every tool call it made, so process invariants
 * (the quality gate ran before each commit, a failing test preceded the first
 * commit, no force-push or amend, turn-budget headroom) can be asserted over
 * that record, and a process failure becomes visible even when the output
 * happens to pass.
 *
 * All four invariants read facts this package already owns:
 * `turn-budget-headroom` measures against `runPolicy.maxTurns`,
 * `no-forbidden-git-ops` defers to {@link classifyCommand}'s own rule set, and
 * `gate-before-commit` / `red-before-green` are the implement phase's contract
 * — which is why the checker lives here rather than in a consumer.
 *
 * **Advisory by contract.** Findings describe a run; they never fail one. A
 * gate built on them is a separate, later decision.
 *
 * No IO: reading and parsing the transcript file stays in `run-trajectory-check.ts`
 * so this half is testable with plain fixtures.
 */

/** A single parsed record from the Claude Code session transcript (JSONL). */
export type TranscriptEvent = Record<string, unknown>

export type TrajectoryStatus = 'pass' | 'fail' | 'not-evaluable'

/** Stable ids — a month of scorecards clusters on these, so they never churn. */
export const TRAJECTORY_INVARIANT_IDS = [
  'gate-before-commit',
  'red-before-green',
  'no-forbidden-git-ops',
  'turn-budget-headroom'
] as const

export type TrajectoryInvariantId = (typeof TRAJECTORY_INVARIANT_IDS)[number]

/** The offending turn (and command) that produced a fail — the evidence. */
export interface TrajectoryEvidence {
  /** 1-based index of the transcript turn the offending tool call belongs to. */
  turnIndex: number
  /** The offending shell command, when the evidence is a Bash call. */
  command?: string
}

export interface TrajectoryFinding {
  id: TrajectoryInvariantId
  title: string
  status: TrajectoryStatus
  /** Terse human-readable evidence line. */
  detail: string
  evidence: TrajectoryEvidence[]
}

export interface CheckTrajectoryOptions {
  /** The run-policy max-turns cap the budget headroom is measured against. */
  maxTurns: number
  /**
   * Fraction of the cap that must remain unused for the budget invariant to
   * pass. Default {@link DEFAULT_HEADROOM_FRACTION} — a run using ≥80% of its
   * turns barely fit and is flagged before it starts failing.
   */
  headroomFraction?: number
  /**
   * What counts as "the quality gate ran" for this repository. Stating a list
   * **replaces** {@link DEFAULT_GATE_COMMAND_PATTERNS} — a repo whose gate is
   * `make check` or a bespoke script names it here, and nothing about the
   * package's defaults leaks into the verdict.
   */
  gateCommandPatterns?: readonly RegExp[]
}

/** Default headroom: flag a run that used ≥80% of its turn cap. */
export const DEFAULT_HEADROOM_FRACTION = 0.2

/**
 * The gate-run commands recognized when a caller states none: a whole-suite
 * run under any of the common JS package managers, or a test runner invoked
 * directly. The `(?![:\w-])` guard is what keeps `test:e2e` and `test-watch`
 * out — a partial or verify-only script is not the gate, and treating it as
 * one would let a run commit on a subset of its suite.
 */
export const DEFAULT_GATE_COMMAND_PATTERNS: readonly RegExp[] = [
  /\b(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?test(?![:\w-])/,
  /\b(?:npx|bunx|pnpm\s+dlx|yarn\s+dlx)\s+(?:jest|vitest)\b/,
  /(?:^|\s)(?:jest|vitest)(?:\s|$)/
]

// --- Command classification ---------------------------------------------------

/** A gate run, per the patterns in force for this check. */
function matchesGate(command: string, patterns: readonly RegExp[]): boolean {
  return patterns.some((pattern) => pattern.test(command))
}

/**
 * The same patterns with any global/sticky flag dropped. A caller's `/…/g`
 * carries a mutable `lastIndex`, which would make the same transcript grade
 * differently on a second call — and this checker is contractually pure.
 */
function stateless(patterns: readonly RegExp[]): readonly RegExp[] {
  return patterns.map((pattern) =>
    /[gy]/.test(pattern.flags)
      ? new RegExp(pattern.source, pattern.flags.replace(/[gy]/g, ''))
      : pattern
  )
}

/** A `git commit` (any form, including `--amend`). */
function isCommit(command: string): boolean {
  return /\bgit\s+commit\b/.test(command)
}

/**
 * The history rewrite a command performs, or null. Detection only, and it asks
 * the command policy rather than restating its rules — the guard that refuses
 * these at spawn time and the checker that reports them after the fact must
 * never drift apart. The policy's third rule (`schema-push`) is not a history
 * rewrite, so it is not this invariant's business.
 */
function forbiddenGitOp(command: string): string | null {
  const verdict = classifyCommand(command)
  if (verdict.decision !== 'block') return null
  return verdict.rule === 'force-push' || verdict.rule === 'amend'
    ? verdict.rule
    : null
}

// --- Normalization ------------------------------------------------------------

interface Action {
  turnIndex: number
  /** The shell command, for a Bash call; null for every other tool. */
  command: string | null
  toolUseId: string | null
  /** From the paired tool_result's is_error; null when unknown/unpaired. */
  failed: boolean | null
}

interface NormalizedTrajectory {
  actions: Action[]
  turnCount: number
  /** False for an empty / truncated / malformed transcript with no turns. */
  evaluable: boolean
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function contentBlocks(
  event: Record<string, unknown>
): Record<string, unknown>[] {
  const message = asRecord(event.message)
  const content = message?.content
  if (!Array.isArray(content)) return []
  return content
    .map(asRecord)
    .filter((block): block is Record<string, unknown> => block !== null)
}

/**
 * Fold the raw transcript into an ordered action list with turn indices and
 * pass/fail results, pairing each tool_use with its tool_result via id. Never
 * throws on odd shapes — an unrecognizable record contributes nothing.
 */
function normalize(events: unknown): NormalizedTrajectory {
  if (!Array.isArray(events)) {
    return { actions: [], turnCount: 0, evaluable: false }
  }

  const resultErrors = new Map<string, boolean>()
  const actions: Action[] = []
  let turnCount = 0
  let lastAssistantId: unknown = Symbol('none')

  for (const raw of events) {
    const event = asRecord(raw)
    if (!event) continue

    if (event.type === 'assistant') {
      const message = asRecord(event.message)
      const id = message?.id
      // A new turn whenever the assistant message id changes (or is absent).
      if (id === undefined || id === null || id !== lastAssistantId) turnCount++
      lastAssistantId = id
      for (const block of contentBlocks(event)) {
        if (block.type !== 'tool_use') continue
        const input = asRecord(block.input) ?? {}
        actions.push({
          turnIndex: turnCount,
          command: typeof input.command === 'string' ? input.command : null,
          toolUseId: typeof block.id === 'string' ? block.id : null,
          failed: null
        })
      }
    } else if (event.type === 'user') {
      for (const block of contentBlocks(event)) {
        if (block.type !== 'tool_result') continue
        const id = block.tool_use_id
        if (typeof id === 'string' && typeof block.is_error === 'boolean') {
          resultErrors.set(id, block.is_error)
        }
      }
    }
  }

  for (const action of actions) {
    if (action.toolUseId !== null && resultErrors.has(action.toolUseId)) {
      action.failed = resultErrors.get(action.toolUseId) ?? null
    }
  }

  return { actions, turnCount, evaluable: turnCount > 0 }
}

// --- Invariants (plain data — add one entry plus fixtures to extend) ----------

interface InvariantContext {
  actions: Action[]
  turnCount: number
  maxTurns: number
  headroomFraction: number
  gatePatterns: readonly RegExp[]
}

interface InvariantResult {
  status: TrajectoryStatus
  detail: string
  evidence: TrajectoryEvidence[]
}

interface InvariantDefinition {
  id: TrajectoryInvariantId
  title: string
  evaluate(ctx: InvariantContext): InvariantResult
}

const INVARIANTS: InvariantDefinition[] = [
  {
    id: 'gate-before-commit',
    title: 'Quality gate ran before every commit',
    evaluate({ actions, gatePatterns }) {
      let gateRan = false
      let commitCount = 0
      const offenders: TrajectoryEvidence[] = []
      for (const action of actions) {
        if (action.command === null) continue
        if (matchesGate(action.command, gatePatterns)) gateRan = true
        if (isCommit(action.command)) {
          commitCount++
          if (!gateRan) {
            offenders.push({
              turnIndex: action.turnIndex,
              command: action.command
            })
          }
          gateRan = false
        }
      }
      if (offenders.length > 0) {
        return {
          status: 'fail',
          detail: `${offenders.length} of ${commitCount} commit(s) not preceded by a gate run`,
          evidence: offenders
        }
      }
      return {
        status: 'pass',
        detail:
          commitCount === 0
            ? 'no commits in this run'
            : `gate ran before each of ${commitCount} commit(s)`,
        evidence: []
      }
    }
  },
  {
    id: 'red-before-green',
    title: 'A failing test preceded the first commit (RED before GREEN)',
    evaluate({ actions, gatePatterns }) {
      const firstCommit = actions.findIndex(
        (action) => action.command !== null && isCommit(action.command)
      )
      if (firstCommit === -1) {
        return {
          status: 'not-evaluable',
          detail: 'no implementation commit to evaluate',
          evidence: []
        }
      }
      const sawFailingTest = actions
        .slice(0, firstCommit)
        .some(
          (action) =>
            action.command !== null &&
            matchesGate(action.command, gatePatterns) &&
            action.failed === true
        )
      if (sawFailingTest) {
        return {
          status: 'pass',
          detail: 'a failing test run preceded the first commit',
          evidence: []
        }
      }
      const commit = actions[firstCommit]
      return {
        status: 'fail',
        detail: 'no failing test run observed before the first commit',
        evidence: [
          { turnIndex: commit.turnIndex, command: commit.command ?? undefined }
        ]
      }
    }
  },
  {
    id: 'no-forbidden-git-ops',
    title: 'No force-push or amend in the trajectory',
    evaluate({ actions }) {
      const offenders: TrajectoryEvidence[] = []
      const kinds = new Set<string>()
      for (const action of actions) {
        if (action.command === null) continue
        const op = forbiddenGitOp(action.command)
        if (op !== null) {
          kinds.add(op)
          offenders.push({
            turnIndex: action.turnIndex,
            command: action.command
          })
        }
      }
      if (offenders.length > 0) {
        return {
          status: 'fail',
          detail: `forbidden git op(s): ${[...kinds].join(', ')}`,
          evidence: offenders
        }
      }
      return { status: 'pass', detail: 'no force-push or amend', evidence: [] }
    }
  },
  {
    id: 'turn-budget-headroom',
    title: 'Turn usage within headroom of the cap',
    evaluate({ turnCount, maxTurns, headroomFraction }) {
      const threshold = Math.ceil(maxTurns * (1 - headroomFraction))
      const detail = `${turnCount}/${maxTurns} turns used`
      if (turnCount >= threshold) {
        return {
          status: 'fail',
          detail: `${detail} (≥${threshold} — under ${Math.round(headroomFraction * 100)}% headroom)`,
          evidence: []
        }
      }
      return { status: 'pass', detail, evidence: [] }
    }
  }
]

/**
 * Grade a parsed transcript against every process invariant. Pure: same events
 * in, same findings out, one finding per id in
 * {@link TRAJECTORY_INVARIANT_IDS}. An empty / truncated / malformed transcript
 * (no assistant turns) grades every invariant `not-evaluable` rather than
 * throwing — a run this cannot read is never a run this condemns.
 */
export function checkTrajectory(
  events: TranscriptEvent[] | unknown,
  options: CheckTrajectoryOptions
): TrajectoryFinding[] {
  const { actions, turnCount, evaluable } = normalize(events)
  if (!evaluable) {
    return INVARIANTS.map((invariant) => ({
      id: invariant.id,
      title: invariant.title,
      status: 'not-evaluable' as const,
      detail: 'transcript not evaluable (empty, truncated, or malformed)',
      evidence: []
    }))
  }
  const ctx: InvariantContext = {
    actions,
    turnCount,
    maxTurns: options.maxTurns,
    headroomFraction: options.headroomFraction ?? DEFAULT_HEADROOM_FRACTION,
    gatePatterns: stateless(
      options.gateCommandPatterns ?? DEFAULT_GATE_COMMAND_PATTERNS
    )
  }
  return INVARIANTS.map((invariant) => ({
    id: invariant.id,
    title: invariant.title,
    ...invariant.evaluate(ctx)
  }))
}

// --- Scorecard formatting (pure: findings in, markdown out) -------------------

const STATUS_MARK: Record<TrajectoryStatus, string> = {
  pass: '✅ pass',
  fail: '❌ fail',
  'not-evaluable': '⚪ n/a'
}

/**
 * Render findings as a terse, stable markdown scorecard: a summary line, a
 * one-row-per-invariant table, then an evidence block for anything that did not
 * pass. Terse on purpose — scanning a month of PRs should surface clustered
 * process failures at a glance. The advisory note is part of the contract, not
 * decoration: a reader must not mistake a ❌ for something that blocked.
 */
export function formatScorecard(findings: TrajectoryFinding[]): string {
  const passes = findings.filter((f) => f.status === 'pass').length
  const lines = [
    '### 🧭 Trajectory scorecard',
    '',
    `${passes}/${findings.length} process invariants passed _(advisory — never blocks the PR)_.`,
    '',
    '| Invariant | Result |',
    '| --- | --- |',
    ...findings.map(
      (finding) => `| ${finding.title} | ${STATUS_MARK[finding.status]} |`
    )
  ]

  const notable = findings.filter((finding) => finding.status !== 'pass')
  if (notable.length > 0) {
    lines.push('')
    for (const finding of notable) {
      const turns = finding.evidence
        .map((evidence) => `turn ${evidence.turnIndex}`)
        .join(', ')
      const where = turns.length > 0 ? ` (${turns})` : ''
      lines.push(`- **${finding.title}** — ${finding.detail}${where}`)
    }
  }

  return lines.join('\n')
}
