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
        wallClockMs: 50
      })

      expect(result.outputTail).toContain('caught-sigterm')
      expect(result.killedBy?.reason).toBe('wall-clock')
    })

    it('escalates to SIGKILL once the grace period expires', async () => {
      const startedAt = Date.now()
      const result = await run(`${IGNORES_SIGTERM}; ${CHATTY}`, {
        wallClockMs: 50,
        sigtermGraceMs: 150
      })

      // Only the escalation can end a child that ignores SIGTERM, so surviving
      // past the grace period is the assertion that SIGKILL followed it.
      expect(Date.now() - startedAt).toBeGreaterThanOrEqual(150)
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
        idleMs: 50,
        sigtermGraceMs: 5_000
      })

      // A child that ignores SIGTERM still dies well inside the grace period,
      // which it could only do if no SIGTERM step preceded the kill.
      expect(Date.now() - startedAt).toBeLessThan(1_000)
      expect(result.killedBy?.reason).toBe('idle')
    })

    it('is held off by output, however long the run goes', async () => {
      const result = await run(
        `${CHATTY}; setTimeout(() => process.exit(0), 80)`,
        {
          idleMs: 40
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
