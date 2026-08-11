/**
 * The orchestrator's own wiring: that the budgets it resolves reach the spawn,
 * and that each guard's kill becomes the right failure. The resolvers are
 * tested pure elsewhere — a suite that stops there stays green while a budget
 * is never read by a run, which is the coverage gap shopfloor#4 exists to
 * close, so everything here goes through `runImplementAgent` itself.
 */

import { runImplementAgent } from './implement'
import { spawnClaude, type SpawnClaudeResult } from './spawn-claude'
import { captureTranscript } from '../observability/transcript'
import type { RunImplementAgentConfig } from './config'
import { WALL_CLOCK_MINUTES_ENV_VAR } from '../guardrails/run-policy'

// Only the subprocess is stubbed; `describeRunawayKill` is pure, and a stubbed
// one would let these assert a failure message no run would ever print.
vi.mock('./spawn-claude', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./spawn-claude')>()),
  spawnClaude: vi.fn()
}))
vi.mock('../observability/transcript', () => ({
  captureTranscript: vi.fn(() => true)
}))
vi.mock('node:child_process', () => ({
  // The post-run commit count; a fresh mock per test overrides it where the
  // number is what's under test.
  execSync: vi.fn(() => '2\n'),
  execFileSync: vi.fn(() => ''),
  spawn: vi.fn()
}))
vi.mock('node:fs', () => ({
  // The command-guard hook resolves against `dist/`, which a source-run test
  // has no copy of, and the PR description is written by the run itself.
  existsSync: vi.fn(() => true),
  readFileSync: vi.fn(() => 'an agent-written PR description'),
  writeFileSync: vi.fn()
}))

const spawnClaudeMock = vi.mocked(spawnClaude)

function baseInput(
  overrides: Partial<RunImplementAgentConfig> = {}
): RunImplementAgentConfig {
  return {
    issueNumber: '4',
    issueTitle: 'Enforce the wall-clock runaway guard',
    branch: 'feat/wall-clock-guard',
    claudeCodeOAuthToken: 'oauth-token',
    promptTemplate: 'Implement issue {{ISSUE_NUMBER}}.',
    env: {},
    cwd: '/repo',
    ...overrides
  }
}

/** The spawn options `runImplementAgent` armed the guards with. */
function armedWith() {
  expect(spawnClaudeMock).toHaveBeenCalledOnce()
  return spawnClaudeMock.mock.calls[0][0]
}

function spawnResult(
  overrides: Partial<SpawnClaudeResult> = {}
): SpawnClaudeResult {
  return { exitCode: 0, killedBy: null, outputTail: '', ...overrides }
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(captureTranscript).mockReturnValue(true)
  spawnClaudeMock.mockResolvedValue(spawnResult())
})

describe('runImplementAgent guard wiring', () => {
  it('arms the spawn with the configured wall-clock budget', async () => {
    await runImplementAgent(baseInput({ runPolicy: { wallClockMinutes: 45 } }))

    expect(armedWith().wallClockMs).toBe(45 * 60_000)
  })

  it('arms the spawn with the configured idle budget', async () => {
    await runImplementAgent(baseInput({ runPolicy: { idleMinutes: 15 } }))

    expect(armedWith().idleMs).toBe(15 * 60_000)
  })

  it('lets LOCAL_WALL_CLOCK_MINUTES override the budget for a single run', async () => {
    await runImplementAgent(
      baseInput({
        runPolicy: { wallClockMinutes: 45 },
        env: { [WALL_CLOCK_MINUTES_ENV_VAR]: '5' }
      })
    )

    expect(armedWith().wallClockMs).toBe(5 * 60_000)
  })

  it('leaves the run without a ceiling when no wall-clock budget is stated', async () => {
    await runImplementAgent(baseInput())

    expect(armedWith().wallClockMs).toBeUndefined()
  })
})

describe('runImplementAgent guard failures', () => {
  const wallClockKill = { reason: 'wall-clock', budgetMs: 45 * 60_000 } as const
  const idleKill = { reason: 'idle', budgetMs: 15 * 60_000 } as const

  it('names the wall-clock budget when the wall-clock guard trips', async () => {
    spawnClaudeMock.mockResolvedValue(spawnResult({ killedBy: wallClockKill }))

    await expect(
      runImplementAgent(baseInput({ runPolicy: { wallClockMinutes: 45 } }))
    ).rejects.toThrow(/45 minute\(s\).*wall-clock guard/)
  })

  it('names the idle budget when the idle guard trips', async () => {
    spawnClaudeMock.mockResolvedValue(spawnResult({ killedBy: idleKill }))

    await expect(
      runImplementAgent(baseInput({ runPolicy: { idleMinutes: 15 } }))
    ).rejects.toThrow(/idle for over 15 minute\(s\)/)
  })

  it('carries the output tail into the failure, whichever guard tripped', async () => {
    spawnClaudeMock.mockResolvedValue(
      spawnResult({ killedBy: wallClockKill, outputTail: 'the last thing it said' })
    )

    await expect(
      runImplementAgent(baseInput())
    ).rejects.toMatchObject({ outputTail: 'the last thing it said' })
  })

  it.each([
    ['wall-clock', wallClockKill],
    ['idle', idleKill]
  ])('still captures the transcript when the %s guard kills the run', async (_name, killedBy) => {
    spawnClaudeMock.mockResolvedValue(spawnResult({ killedBy }))

    await expect(runImplementAgent(baseInput())).rejects.toThrow()
    expect(captureTranscript).toHaveBeenCalled()
  })

  it('fails a wall-clock kill even when the agent had already committed', async () => {
    // Decided in shopfloor#4: unlike a missing PR description, a run the
    // wall-clock guard cut off never reached its own verify phase, so its
    // commits are unvetted work-in-progress rather than a shippable PR. The
    // mocked `git rev-list` reports 2 commits, and the run still fails.
    spawnClaudeMock.mockResolvedValue(spawnResult({ killedBy: wallClockKill }))

    await expect(runImplementAgent(baseInput())).rejects.toThrow(
      /wall-clock guard/
    )
  })

  it('reports a run that ended on its own', async () => {
    const result = await runImplementAgent(baseInput())

    expect(result).toMatchObject({
      branch: 'feat/wall-clock-guard',
      commitsAhead: 2,
      transcriptCaptured: true,
      prDescription: 'agent'
    })
  })
})
