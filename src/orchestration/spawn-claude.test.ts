/**
 * The guards are timers around a real child process, so these exercise a real
 * child process — a `node -e` stand-in for the Claude CLI, with the budgets and
 * the check interval turned down to milliseconds. Mocking `spawn` here would
 * assert that the code calls `kill`, not that a runaway run actually dies.
 */

import {
  SIGTERM_GRACE_MS,
  describeRunawayKill,
  spawnClaude,
  type SpawnClaudeOptions
} from './spawn-claude'

/** A child that keeps writing forever: immune to the idle guard by construction. */
const CHATTY = "setInterval(() => process.stdout.write('.'), 5)"

/** A child that lives forever in silence: exactly what the idle guard is for. */
const SILENT = 'setInterval(() => {}, 1000)'

/** Traps `SIGTERM` and announces it, so only a `SIGKILL` can end the process. */
const IGNORES_SIGTERM =
  "process.on('SIGTERM', () => process.stdout.write('caught-sigterm'))"

/**
 * A budget that clears the stand-in child's own startup. Every budget runs from
 * `spawn`, but the child cannot write, or install a signal handler, until node
 * has booted — a few hundred ms on a loaded machine. Any test whose subject is
 * what the *running* child does needs a budget above that, or it is really
 * testing node's boot time.
 */
const AFTER_STARTUP_MS = 500

function run(
  script: string,
  overrides: Partial<SpawnClaudeOptions> = {}
): Promise<Awaited<ReturnType<typeof spawnClaude>>> {
  return spawnClaude({
    command: process.execPath,
    args: ['-e', script],
    prompt: 'ignored-by-the-stand-in',
    env: process.env,
    cwd: process.cwd(),
    idleMs: 60_000,
    checkIntervalMs: 5,
    sigtermGraceMs: 60,
    onSpawnError: () => {},
    ...overrides
  })
}

describe('spawnClaude runaway guards', () => {
  it('lets a run that finishes inside both budgets report its own exit code', async () => {
    const result = await run('process.exit(3)', {
      idleMs: 5_000,
      wallClockMs: 5_000
    })

    expect(result.killedBy).toBeNull()
    expect(result.exitCode).toBe(3)
  })

  it('keeps the tail of the child output for failure diagnostics', async () => {
    const result = await run("process.stdout.write('hello from the agent')")

    expect(result.outputTail).toContain('hello from the agent')
  })

  describe('the wall-clock guard', () => {
    it('kills a chatty run the idle guard would never catch', async () => {
      const result = await run(CHATTY, { idleMs: 60_000, wallClockMs: 50 })

      expect(result.killedBy).toEqual({ reason: 'wall-clock', budgetMs: 50 })
    })

    it('never fires when no wall-clock budget is stated', async () => {
      const result = await run(
        `${CHATTY}; setTimeout(() => process.exit(0), 80)`,
        {
          idleMs: 60_000
        }
      )

      expect(result.killedBy).toBeNull()
      expect(result.exitCode).toBe(0)
    })

    it('sends SIGTERM first, giving a looping agent a chance to flush', async () => {
      const result = await run(`${IGNORES_SIGTERM}; ${CHATTY}`, {
        wallClockMs: AFTER_STARTUP_MS
      })

      expect(result.outputTail).toContain('caught-sigterm')
      expect(result.killedBy?.reason).toBe('wall-clock')
    })

    it('escalates to SIGKILL once the grace period expires', async () => {
      const startedAt = Date.now()
      const result = await run(`${IGNORES_SIGTERM}; ${CHATTY}`, {
        wallClockMs: AFTER_STARTUP_MS,
        sigtermGraceMs: 150
      })

      // Only the escalation can end a child that ignores SIGTERM, so surviving
      // past the grace period is the assertion that SIGKILL followed it.
      expect(Date.now() - startedAt).toBeGreaterThanOrEqual(
        AFTER_STARTUP_MS + 150
      )
      expect(result.killedBy?.reason).toBe('wall-clock')
    })

    it('waits 30 seconds before escalating, when no test shortens it', () => {
      // The tests above have to run in milliseconds, so nothing else in this
      // file would notice the shipped grace period changing.
      expect(SIGTERM_GRACE_MS).toBe(30_000)
    })
  })

  describe('the idle guard', () => {
    it('kills a run whose output has gone silent', async () => {
      const result = await run(SILENT, { idleMs: 50 })

      expect(result.killedBy).toEqual({ reason: 'idle', budgetMs: 50 })
    })

    it('goes straight to SIGKILL rather than waiting out a grace period', async () => {
      const startedAt = Date.now()
      const result = await run(`${IGNORES_SIGTERM}; ${SILENT}`, {
        idleMs: AFTER_STARTUP_MS,
        sigtermGraceMs: 5_000
      })

      // A child that ignores SIGTERM still dies well inside the grace period,
      // which it could only do if no SIGTERM step preceded the kill.
      expect(Date.now() - startedAt).toBeLessThan(AFTER_STARTUP_MS + 1_000)
      expect(result.killedBy?.reason).toBe('idle')
    })

    it('is held off by output, however long the run goes', async () => {
      const result = await run(
        `${CHATTY}; setTimeout(() => process.exit(0), ${AFTER_STARTUP_MS * 2})`,
        {
          idleMs: AFTER_STARTUP_MS
        }
      )

      expect(result.killedBy).toBeNull()
    })
  })

  it('reports the first budget to trip when both are exceeded', async () => {
    const result = await run(SILENT, { idleMs: 30, wallClockMs: 5_000 })

    expect(result.killedBy?.reason).toBe('idle')
  })

  it('turns a command that cannot start into a spawn error, after saving the transcript', async () => {
    let transcriptSaved = false

    await expect(
      run('unused', {
        command: '/nonexistent/claude',
        onSpawnError: () => {
          transcriptSaved = true
        }
      })
    ).rejects.toThrow(/Failed to start the Claude CLI/)
    expect(transcriptSaved).toBe(true)
  })
})

/**
 * The metering's own edge cases are `usage.test.ts`'s, over recorded fixtures.
 * These prove the wiring the unit tests cannot: that a real spawn feeds stdout
 * to the meter, that stderr is not fed to it, that a killed run still reports,
 * and that the meter did not take the idle guard's heartbeat away.
 */
describe('spawnClaude usage metering', () => {
  /** Recorded: the terminal `result` event of a `stream-json` session. */
  const RESULT_LINE =
    '{"type":"result","subtype":"success","total_cost_usd":0.0776655,"usage":{"input_tokens":2,"cache_creation_input_tokens":6930,"cache_read_input_tokens":16011,"output_tokens":14}}'

  /** A child that writes `text` to the named stream and exits cleanly. */
  const writes = (stream: 'stdout' | 'stderr', text: string) =>
    `process.${stream}.write(${JSON.stringify(text)}); process.exit(0)`

  it('totals the stream-json the CLI wrote to stdout', async () => {
    const result = await run(writes('stdout', `${RESULT_LINE}\n`))

    expect(result.usage).toEqual({
      inputTokens: 2,
      outputTokens: 14,
      cacheCreationInputTokens: 6930,
      cacheReadInputTokens: 16011,
      costUsd: 0.0776655,
      source: 'reported'
    })
  })

  it('does not meter stderr, which carries the CLI prose rather than the stream', async () => {
    const result = await run(writes('stderr', `${RESULT_LINE}\n`))

    expect(result.usage.source).toBe('observed')
    expect(result.usage.outputTokens).toBe(0)
  })

  it('reports zeroes rather than nothing for a run that streamed no usage', async () => {
    const result = await run(writes('stdout', 'not stream-json at all\n'))

    expect(result.usage).toEqual(
      expect.objectContaining({ outputTokens: 0, source: 'observed' })
    )
  })

  it('still reports what a killed run spent before the guard ended it', async () => {
    const result = await run(
      `process.stdout.write(${JSON.stringify(`${RESULT_LINE}\n`)}); ${SILENT}`,
      { idleMs: AFTER_STARTUP_MS }
    )

    expect(result.killedBy?.reason).toBe('idle')
    expect(result.usage.outputTokens).toBe(14)
  })

  it('leaves the idle guard its heartbeat: a streaming run is not killed', async () => {
    const streaming = `setInterval(() => process.stdout.write(${JSON.stringify(`${RESULT_LINE}\n`)}), 5)`
    const result = await run(
      `${streaming}; setTimeout(() => process.exit(0), ${AFTER_STARTUP_MS * 2})`,
      { idleMs: AFTER_STARTUP_MS }
    )

    expect(result.killedBy).toBeNull()
  })
})

describe('describeRunawayKill', () => {
  it('names the guard and the budget it enforced', () => {
    expect(
      describeRunawayKill({ reason: 'wall-clock', budgetMs: 45 * 60_000 })
    ).toBe('Agent ran for over 45 minute(s) — killed by the wall-clock guard.')
    expect(describeRunawayKill({ reason: 'idle', budgetMs: 15 * 60_000 })).toBe(
      'Agent idle for over 15 minute(s) — killed by the idle guard.'
    )
  })

  it('reports a sub-minute budget in seconds rather than as zero minutes', () => {
    expect(
      describeRunawayKill({ reason: 'wall-clock', budgetMs: 30_000 })
    ).toContain('30 second(s)')
  })
})
