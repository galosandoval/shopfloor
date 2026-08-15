/**
 * The inner loop's decision, tested as a table of facts in and verdicts out —
 * no process, no clock, no mocking. That the shell actually calls it, runs the
 * gate, and spawns again lives in `implement.test.ts`.
 */

import {
  evaluateIteration,
  MIN_ITERATION_WALL_CLOCK_MS,
  type GateResult
} from './iteration'

function failingGate(overrides: Partial<GateResult> = {}): GateResult {
  return {
    command: 'bun run typecheck && bun run test',
    passed: false,
    outputTail: 'FAIL src/thing.test.ts',
    ...overrides
  }
}

describe('evaluateIteration', () => {
  it('is done when the gate passed', () => {
    expect(
      evaluateIteration({
        iteration: 1,
        maxIterations: 3,
        gate: failingGate({ passed: true })
      })
    ).toEqual({ kind: 'done' })
  })

  it('is done when no gate was stated — a run with no signal is single-shot', () => {
    expect(evaluateIteration({ iteration: 1, maxIterations: 3 })).toEqual({
      kind: 'done'
    })
  })

  it('iterates on a failing gate with budget left', () => {
    const verdict = evaluateIteration({
      iteration: 1,
      maxIterations: 3,
      gate: failingGate()
    })

    expect(verdict.kind).toBe('iterate')
  })

  it('feeds the failing command and its output into the next turn', () => {
    const verdict = evaluateIteration({
      iteration: 1,
      maxIterations: 3,
      gate: failingGate()
    })

    expect(verdict).toMatchObject({
      kind: 'iterate',
      feedback: expect.stringContaining('bun run typecheck && bun run test')
    })
    expect(verdict).toMatchObject({
      feedback: expect.stringContaining('FAIL src/thing.test.ts')
    })
  })

  it('tells the next turn where it stands in the budget', () => {
    const verdict = evaluateIteration({
      iteration: 2,
      maxIterations: 5,
      gate: failingGate()
    })

    expect(verdict).toMatchObject({
      feedback: expect.stringContaining('Attempt 2 of 5')
    })
  })

  it('gives a different turn different feedback, so no two are identical', () => {
    const first = evaluateIteration({
      iteration: 1,
      maxIterations: 3,
      gate: failingGate({ outputTail: 'typecheck failed' })
    })
    const second = evaluateIteration({
      iteration: 2,
      maxIterations: 3,
      gate: failingGate({ outputTail: 'one test still red' })
    })

    expect(first).not.toEqual(second)
  })

  it('is exhausted when the last iteration left the gate red', () => {
    const verdict = evaluateIteration({
      iteration: 3,
      maxIterations: 3,
      gate: failingGate()
    })

    expect(verdict).toMatchObject({
      kind: 'exhausted',
      reason: expect.stringContaining('3 iteration(s)')
    })
  })

  it('never iterates past the ceiling, even if the count overshot it', () => {
    expect(
      evaluateIteration({ iteration: 4, maxIterations: 3, gate: failingGate() })
    ).toMatchObject({ kind: 'exhausted' })
  })

  it('is single-shot at a ceiling of one — the pre-loop behaviour', () => {
    expect(
      evaluateIteration({ iteration: 1, maxIterations: 1, gate: failingGate() })
    ).toMatchObject({ kind: 'exhausted' })
  })

  it('is exhausted when the run has no wall clock left to spawn into', () => {
    const verdict = evaluateIteration({
      iteration: 1,
      maxIterations: 3,
      gate: failingGate(),
      remainingWallClockMs: 0
    })

    expect(verdict).toMatchObject({
      kind: 'exhausted',
      reason: expect.stringContaining('wall-clock')
    })
  })

  it('iterates while wall-clock budget remains', () => {
    expect(
      evaluateIteration({
        iteration: 1,
        maxIterations: 3,
        gate: failingGate(),
        remainingWallClockMs: 10 * MIN_ITERATION_WALL_CLOCK_MS
      })
    ).toMatchObject({ kind: 'iterate' })
  })

  it('stops short of a spawn too small to be worth starting', () => {
    // Not a rounding nicety: that spawn would be killed by the wall-clock
    // guard, so the run would report a runaway agent rather than a spent
    // budget — the wrong cause, for a failure this can see coming.
    expect(
      evaluateIteration({
        iteration: 1,
        maxIterations: 3,
        gate: failingGate(),
        remainingWallClockMs: MIN_ITERATION_WALL_CLOCK_MS - 1
      })
    ).toMatchObject({ kind: 'exhausted' })
  })

  it('lets a run with no stated ceiling iterate on the count alone', () => {
    expect(
      evaluateIteration({
        iteration: 1,
        maxIterations: 3,
        gate: failingGate(),
        remainingWallClockMs: undefined
      })
    ).toMatchObject({ kind: 'iterate' })
  })

  it('names the iteration budget when both budgets are spent at once', () => {
    expect(
      evaluateIteration({
        iteration: 3,
        maxIterations: 3,
        gate: failingGate(),
        remainingWallClockMs: 0
      })
    ).toMatchObject({ reason: expect.stringContaining('maxIterations') })
  })
})
