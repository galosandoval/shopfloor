/**
 * The closure condition (shopfloor#48), tested the way every decision in this
 * package is: a table of scorecards and budget states in, verdicts out, with
 * nothing mocked. The wiring — that a run actually asks this before it closes —
 * is `orchestration/implement.test.ts`, and it has to be separate: a green
 * suite here would say nothing about whether the gate is armed.
 */

import {
  evaluateClosure,
  resolveGatePatterns,
  GATING_TRAJECTORY_INVARIANTS
} from './closure'
import {
  DEFAULT_GATE_COMMAND_PATTERNS,
  type TrajectoryFinding,
  type TrajectoryInvariantId,
  type TrajectoryStatus
} from '../observability/trajectory'

/** A scorecard where every invariant passed, then whatever a test overrides. */
function scorecard(
  overrides: Partial<Record<TrajectoryInvariantId, TrajectoryStatus>> = {}
): TrajectoryFinding[] {
  return (
    [
      ['gate-before-commit', 'Quality gate ran before every commit'],
      ['red-before-green', 'A failing test preceded the first commit'],
      ['no-forbidden-git-ops', 'No force-push or amend in the trajectory'],
      ['turn-budget-headroom', 'Turn usage within headroom of the cap']
    ] as const
  ).map(([id, title]) => ({
    id,
    title,
    status: overrides[id] ?? 'pass',
    detail: `${id} detail`,
    evidence:
      overrides[id] === 'fail'
        ? [{ turnIndex: 7, command: 'git commit -m x' }]
        : []
  }))
}

describe('evaluateClosure', () => {
  it('closes a run whose gating invariants passed', () => {
    expect(
      evaluateClosure({ findings: scorecard(), budgetRemaining: true })
    ).toEqual({ kind: 'pass' })
  })

  it('closes a run whose only failures are advisory', () => {
    const verdict = evaluateClosure({
      findings: scorecard({
        'no-forbidden-git-ops': 'fail',
        'turn-budget-headroom': 'fail'
      }),
      budgetRemaining: false
    })

    expect(verdict.kind).toBe('pass')
  })

  it('closes a run whose gating invariant had nothing to judge, given another that did', () => {
    // No commits yet: `red-before-green` has no first commit to measure against
    // while `gate-before-commit` passes vacuously. That is a graded run with no
    // violation, not an ungraded one.
    const verdict = evaluateClosure({
      findings: scorecard({ 'red-before-green': 'not-evaluable' }),
      budgetRemaining: true
    })

    expect(verdict.kind).toBe('pass')
  })

  it.each(GATING_TRAJECTORY_INVARIANTS)(
    're-enters the loop on a %s violation with budget remaining',
    (id) => {
      const verdict = evaluateClosure({
        findings: scorecard({ [id]: 'fail' }),
        budgetRemaining: true
      })

      expect(verdict).toMatchObject({ kind: 're-enter', violations: [id] })
    }
  )

  it('carries the violation into the next attempt rather than retrying blind', () => {
    const verdict = evaluateClosure({
      findings: scorecard({ 'red-before-green': 'fail' }),
      budgetRemaining: true
    })

    if (verdict.kind !== 're-enter') throw new Error('expected a re-entry')
    expect(verdict.feedback).toContain(
      'A failing test preceded the first commit'
    )
    expect(verdict.feedback).toContain('red-before-green detail')
    expect(verdict.feedback).toContain('turn 7')
  })

  it.each(GATING_TRAJECTORY_INVARIANTS)(
    'blocks on a %s violation with the budget spent',
    (id) => {
      const verdict = evaluateClosure({
        findings: scorecard({ [id]: 'fail' }),
        budgetRemaining: false
      })

      expect(verdict).toMatchObject({
        kind: 'block',
        cause: 'violation',
        violations: [id]
      })
    }
  )

  it('names every violated invariant in the blocking reason', () => {
    const verdict = evaluateClosure({
      findings: scorecard({
        'gate-before-commit': 'fail',
        'red-before-green': 'fail'
      }),
      budgetRemaining: false
    })

    if (verdict.kind !== 'block') throw new Error('expected a block')
    expect(verdict.violations).toEqual([...GATING_TRAJECTORY_INVARIANTS])
    expect(verdict.reason).toContain('gate-before-commit')
    expect(verdict.reason).toContain('red-before-green')
    expect(verdict.reason).toContain('gate-before-commit detail')
  })

  it.each([true, false])(
    'blocks an ungraded run whether or not budget remains (budgetRemaining: %s)',
    (budgetRemaining) => {
      const verdict = evaluateClosure({ findings: null, budgetRemaining })

      expect(verdict).toMatchObject({
        kind: 'block',
        cause: 'no-evidence',
        violations: []
      })
    }
  )

  it('blocks a transcript that graded nothing at all', () => {
    // What `checkTrajectory` returns for an empty, truncated, or malformed
    // transcript: every invariant `not-evaluable`. Read as a pass, it would be
    // the cheapest way past this gate.
    const verdict = evaluateClosure({
      findings: scorecard({
        'gate-before-commit': 'not-evaluable',
        'red-before-green': 'not-evaluable'
      }),
      budgetRemaining: true
    })

    expect(verdict).toMatchObject({ kind: 'block', cause: 'no-evidence' })
  })

  it('blocks a scorecard carrying no gating invariant at all', () => {
    const verdict = evaluateClosure({ findings: [], budgetRemaining: true })

    expect(verdict).toMatchObject({ kind: 'block', cause: 'no-evidence' })
  })
})

describe('resolveGatePatterns', () => {
  it('grades against the package defaults when no gate command was stated', () => {
    expect(resolveGatePatterns(undefined)).toEqual(
      DEFAULT_GATE_COMMAND_PATTERNS
    )
  })

  it('recognizes the consumer gate the harness itself runs', () => {
    const patterns = resolveGatePatterns('make check')

    expect(patterns.some((pattern) => pattern.test('make check'))).toBe(true)
  })

  it('keeps the defaults alongside it', () => {
    const patterns = resolveGatePatterns('make check')

    expect(patterns.some((pattern) => pattern.test('npm test'))).toBe(true)
  })

  it('matches the stated gate literally, metacharacters included', () => {
    const patterns = resolveGatePatterns('bun run test:all (fast)')

    expect(
      patterns.some((pattern) => pattern.test('bun run test:all (fast)'))
    ).toBe(true)
  })
})
