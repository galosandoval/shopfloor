/**
 * The inner loop's decision (shopfloor#40): given the quality gate's result and
 * where the loop stands against its budgets, does the run spawn the CLI again?
 *
 * Pure — no clock, no subprocess, no `fs`. The shell (`runImplementAgent`) runs
 * the gate, measures the wall clock, and acts on the verdict; everything that
 * decides whether a run is finished lives here where it can be read in one
 * sitting and tested without mocking a process.
 *
 * Three design questions were open before this module existed — what generates
 * the signal, respawn or resume, and what the runaway guards bound — and the
 * shape of {@link IterationInput} is their answer: a `gate` the harness ran, a
 * `feedback` string for the next spawn, and a `remainingWallClockMs` belonging
 * to the run rather than to one spawn. Each is argued where it is enforced (see
 * {@link IterationInput}'s fields and `feedbackFor`); the decisions themselves,
 * with the alternatives they were taken over, are recorded once in
 * `CONTEXT.md` § "The inner loop's three decisions".
 */

/** What the harness saw when it ran the consumer's quality gate. */
export interface GateResult {
  /** The command as stated, so a failure names what was run. */
  command: string
  /** Whether it exited zero. */
  passed: boolean
  /** Bounded tail of its combined stdout/stderr — what the next turn is told. */
  outputTail: string
}

export interface IterationInput {
  /** 1-based index of the iteration that just finished. */
  iteration: number
  /** The loop's own budget, from `runPolicy.maxIterations`. */
  maxIterations: number
  /**
   * Absent when the caller stated no gate command. A run with no gate has no
   * signal to iterate on, so it is single-shot — exactly as every run was
   * before this loop existed.
   */
  gate?: GateResult
  /**
   * What is left of the run's wall-clock ceiling, in ms, before another spawn.
   * Undefined when no ceiling was stated, which is the one case where only the
   * iteration count bounds the loop.
   */
  remainingWallClockMs?: number
}

/**
 * The least wall clock an iteration is worth starting with. A spawn given less
 * than this does not fail differently — it fails *worse*: the wall-clock guard
 * kills it, so the run reports a runaway agent instead of a spent budget, and
 * names the wrong cause of a failure the loop could see coming. A minute is
 * also under the guard's own 15-second check interval plus its 30-second
 * `SIGTERM` grace, so anything smaller is mostly teardown.
 */
export const MIN_ITERATION_WALL_CLOCK_MS = 60_000

/**
 * What the loop does next. `exhausted` is a *failure*: a run that spent its
 * budget with the gate still red produced work that does not pass, and reporting
 * it as a success is the outcome the loop exists to prevent.
 */
export type IterationVerdict =
  | { kind: 'done' }
  | { kind: 'iterate'; feedback: string }
  | { kind: 'exhausted'; reason: string }

/**
 * Whether to spawn the CLI again, and what to tell it if so.
 *
 * The budgets are checked in the order a reader would ask about them: the gate
 * settles whether there is anything to fix at all, then the loop's own
 * iteration budget, then the run's wall clock. When both budgets are spent at
 * once the iteration count is what the failure names — it is the bound the loop
 * was configured with, and the wall clock has its own kill path in
 * `spawnClaude` for the run it actually cuts off.
 *
 * The wall clock stops the loop at {@link MIN_ITERATION_WALL_CLOCK_MS} rather
 * than at zero, so the loop ends by naming the budget it spent instead of
 * starting one more spawn for the guard to kill.
 */
export function evaluateIteration(input: IterationInput): IterationVerdict {
  const { gate, iteration, maxIterations } = input

  if (!gate || gate.passed) return { kind: 'done' }

  const budget = checkIterationBudget(input)
  if (!budget.available) {
    return {
      kind: 'exhausted',
      reason:
        `The quality gate \`${gate.command}\` still failed after ` +
        `${iteration} iteration(s) — ${budget.spent}.`
    }
  }

  return {
    kind: 'iterate',
    feedback: feedbackFor(gate, iteration, maxIterations)
  }
}

/**
 * Whether the loop may spawn again, which bound stopped it when not, and how
 * that bound reads in a failure a human sees.
 *
 * The phrase rides on the verdict rather than being re-derived from `bound` at
 * each caller: two callers already ask this question (a red gate and an
 * unclosed trajectory), and a bound whose wording lives at the call sites is a
 * third bound to keep in step every time one is added.
 */
export type IterationBudgetVerdict =
  | { available: true }
  | {
      available: false
      bound: 'iterations' | 'wall-clock'
      /** The bound as a clause, e.g. "the run's wall-clock budget is spent…". */
      spent: string
    }

/**
 * Whether the run has room for another attempt, asked without reference to why
 * one might be wanted.
 *
 * Extracted so the two things that can send a run round again — a red gate
 * ({@link evaluateIteration}) and a trajectory that does not close
 * (`guardrails/closure.ts`, shopfloor#48) — measure the same budget rather than
 * each carrying its own copy of the arithmetic. Two copies of a ceiling is how
 * a ceiling stops being one.
 *
 * The bounds are checked in the order a reader would ask about them, and when
 * both are spent at once the iteration count is what the caller names — it is
 * the bound the loop was configured with, and the wall clock has its own kill
 * path in `spawnClaude` for the run it actually cuts off.
 */
export function checkIterationBudget(
  input: Pick<
    IterationInput,
    'iteration' | 'maxIterations' | 'remainingWallClockMs'
  >
): IterationBudgetVerdict {
  if (input.iteration >= input.maxIterations) {
    return {
      available: false,
      bound: 'iterations',
      spent:
        `the run's iteration budget (maxIterations: ${input.maxIterations}) ` +
        'is spent'
    }
  }
  if (
    input.remainingWallClockMs !== undefined &&
    input.remainingWallClockMs < MIN_ITERATION_WALL_CLOCK_MS
  ) {
    return {
      available: false,
      bound: 'wall-clock',
      spent:
        "the run's wall-clock budget is spent, with too little left to be " +
        'worth another attempt'
    }
  }
  return { available: true }
}

/**
 * What the next spawn is told about the last one. This is the whole reason a
 * fresh spawn is not a retry of an identical run: the prompt it gets carries a
 * failure the previous prompt did not, so an agent that would otherwise
 * re-derive the same wrong approach has something new to work from.
 *
 * A fresh spawn rather than `--resume` is deliberate. Resuming keeps the
 * trajectory — and the reasoning that produced the failing work — in the
 * context of the turn meant to correct it, which is the context rot the loop
 * design warns about. It also depends on recovering a session id, which this
 * package does not parse out of the CLI's stream, and it is unavailable exactly
 * when a spawn was killed. The cost is real and named: every iteration pays for
 * its static context again.
 *
 * **Facts, and one line of contract — no procedure.** How to fix a failing test
 * suite is exactly the per-consumer prompt content this package does not ship,
 * and telling the agent how to behave from here would put procedure in the one
 * place a consumer cannot override it. What the harness may say is what the
 * harness saw: which command it ran, what came back, and that the run is not
 * over until that command passes.
 */
function feedbackFor(
  gate: GateResult,
  iteration: number,
  maxIterations: number
): string {
  return [
    '',
    '## The previous attempt did not pass the quality gate',
    '',
    `Attempt ${iteration} of ${maxIterations} ended with \`${gate.command}\` ` +
      'failing. Its output:',
    '',
    '```',
    gate.outputTail.trim(),
    '```',
    '',
    'The harness runs that command itself, and this run is not finished until ' +
      'it exits zero.'
  ].join('\n')
}
