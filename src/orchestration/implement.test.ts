/**
 * The orchestrator's own wiring: that the budgets it resolves reach the spawn,
 * that each guard's kill becomes the right failure, and that the pre-spawn
 * preconditions (shopfloor#5) refuse before any tokens are spent. The
 * resolvers are tested pure elsewhere — a suite that stops there stays green
 * while a budget is never read by a run, which is the coverage gap
 * shopfloor#4 exists to close, so everything here goes through
 * `runImplementAgent` itself.
 */

import { execSync } from 'node:child_process'
import { runImplementAgent } from './implement'
import { ImplementAgentError } from './implement-error'
import { resolveBundledPluginDir } from './bundled-plugin'
import { spawnClaude, type SpawnClaudeResult } from './spawn-claude'
import {
  captureTranscript,
  preserveIterationTranscript
} from '../observability/transcript'
import { NO_RUN_USAGE } from '../observability/usage'
import type { RunImplementAgentConfig } from './config'
import { WALL_CLOCK_MINUTES_ENV_VAR } from '../guardrails/run-policy'
import { ENVIRONMENT_UNFILLED_SENTINEL } from '../setup/setup'

// Only the subprocess is stubbed; `describeRunawayKill` is pure, and a stubbed
// one would let these assert a failure message no run would ever print.
vi.mock('./spawn-claude', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./spawn-claude')>()),
  spawnClaude: vi.fn()
}))
vi.mock('../observability/transcript', async (importOriginal) => ({
  // `iterationTranscriptPath` stays real — it is pure, and a stubbed one would
  // let these assert a filename no run would ever write.
  ...(await importOriginal<typeof import('../observability/transcript')>()),
  captureTranscript: vi.fn(() => true),
  preserveIterationTranscript: vi.fn(() => true)
}))
// Hoisted so the stubs a test reprograms are held as plain `vi.fn()`s: these
// built-ins are heavily overloaded, and addressing them through `vi.mocked`
// would mean casting past an overload set to stub one return.
const { execFileSyncMock, statSyncMock, readFileSyncMock, spawnSyncMock } =
  vi.hoisted(() => ({
    execFileSyncMock: vi.fn(),
    statSyncMock: vi.fn(),
    readFileSyncMock: vi.fn(),
    spawnSyncMock: vi.fn()
  }))

vi.mock('node:child_process', () => ({
  // The post-run commit count; a fresh mock per test overrides it where the
  // number is what's under test.
  execSync: vi.fn(() => '2\n'),
  execFileSync: execFileSyncMock,
  // The quality gate — the only subprocess `runGate` runs. Real `runGate`
  // either way: stubbing it would prove only that a stub was called.
  spawnSync: spawnSyncMock,
  spawn: vi.fn()
}))
vi.mock('node:fs', () => ({
  // The command-guard hook resolves against `dist/`, which a source-run test
  // has no copy of, and the PR description is written by the run itself.
  existsSync: vi.fn(() => true),
  readFileSync: readFileSyncMock,
  writeFileSync: vi.fn(),
  statSync: statSyncMock
}))

const spawnClaudeMock = vi.mocked(spawnClaude)

/** The version a probed `claude --version` reports, in the CLI's own format. */
function runningCliVersion(version: string | undefined) {
  execFileSyncMock.mockImplementation((file: string) =>
    file === 'claude' && version ? `${version} (Claude Code)` : ''
  )
}

/**
 * A filesystem where every plugin directory is a valid plugin: a manifest
 * declaring one skill that exists, and neither `hooks/` nor `.mcp.json`. Also
 * the suite's default, since an unstated list resolves to the bundled plugin
 * and every run therefore probes one. The real `runPluginDirsCheck` runs
 * against this — stubbing the check itself would prove only that a stub was
 * called.
 */
function pluginDirsAreValid({ shipsHooks }: { shipsHooks?: boolean } = {}) {
  statSyncMock.mockImplementation((target: string) => {
    const isCapability =
      target.endsWith('/hooks') || target.endsWith('/.mcp.json')
    if (isCapability && !shipsHooks) throw new Error('ENOENT')
    return { isDirectory: () => !target.endsWith('.json') }
  })
  readFileSyncMock.mockImplementation((target: string) =>
    target.endsWith('plugin.json')
      ? JSON.stringify({ name: 'skills', skills: ['./skills/tdd'] })
      : 'an agent-written PR description'
  )
}

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

/** The spawn options of the nth (1-based) iteration of a run that looped. */
function spawnNumber(n: number) {
  return spawnClaudeMock.mock.calls[n - 1][0]
}

/**
 * What the caller's gate command exits with, per iteration — one entry per
 * spawn, the last repeating once the list runs out.
 */
function gateExits(...statuses: number[]) {
  let call = 0
  spawnSyncMock.mockImplementation(() => {
    const status = statuses[Math.min(call++, statuses.length - 1)]
    return { status, stdout: `gate output ${call}`, stderr: '' }
  })
}

function spawnResult(
  overrides: Partial<SpawnClaudeResult> = {}
): SpawnClaudeResult {
  return {
    exitCode: 0,
    killedBy: null,
    outputTail: '',
    usage: NO_RUN_USAGE,
    ...overrides
  }
}

/** A spawn that metered `costUsd` and a round number of output tokens. */
function spent(costUsd: number, outputTokens: number): SpawnClaudeResult {
  return spawnResult({
    usage: { ...NO_RUN_USAGE, outputTokens, costUsd, source: 'reported' }
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(captureTranscript).mockReturnValue(true)
  spawnClaudeMock.mockResolvedValue(spawnResult())
  // Implementations survive `clearAllMocks`, so every per-test override above
  // is restored to the happy default here rather than leaking into the next.
  runningCliVersion('2.1.220')
  gateExits(0)
  // Every run resolves a plugin directory now — the bundled one when nothing
  // states a list — so a filesystem answering plugin probes is the baseline,
  // not a per-suite arrangement.
  pluginDirsAreValid()
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

describe('runImplementAgent CLI-version precondition', () => {
  let warn: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
  })

  afterEach(() => {
    warn.mockRestore()
  })

  it('records the running CLI version on the result', async () => {
    runningCliVersion('2.1.220')

    const result = await runImplementAgent(baseInput())

    expect(result.cliVersion).toBe('2.1.220')
  })

  it('records nothing when the running version cannot be read', async () => {
    runningCliVersion(undefined)

    const result = await runImplementAgent(baseInput())

    expect(result.cliVersion).toBeUndefined()
  })

  it('warns on a mismatch without blocking the run', async () => {
    runningCliVersion('3.1.220')

    const result = await runImplementAgent(
      baseInput({ runPolicy: { cliVersion: '2.1.220' } })
    )

    expect(warn).toHaveBeenCalledWith(expect.stringContaining('3.1.220'))
    expect(result.cliVersion).toBe('3.1.220')
    expect(spawnClaudeMock).toHaveBeenCalled()
  })

  it('says nothing when the running version matches the pin', async () => {
    runningCliVersion('2.1.220')

    await runImplementAgent(baseInput({ runPolicy: { cliVersion: '2.1.208' } }))

    expect(warn).not.toHaveBeenCalled()
  })

  it('says nothing when no version is pinned', async () => {
    await runImplementAgent(baseInput())

    expect(warn).not.toHaveBeenCalled()
  })

  it('fails before spawning under error strictness', async () => {
    runningCliVersion('3.1.220')

    await expect(
      runImplementAgent(
        baseInput({
          runPolicy: { cliVersion: '2.1.220', cliVersionStrictness: 'error' }
        })
      )
    ).rejects.toThrow(/3\.1\.220.*2\.1\.220/s)
    expect(spawnClaudeMock).not.toHaveBeenCalled()
  })

  it('runs unbothered under off strictness, even on a mismatch', async () => {
    runningCliVersion('3.1.220')

    await runImplementAgent(
      baseInput({
        runPolicy: { cliVersion: '2.1.220', cliVersionStrictness: 'off' }
      })
    )

    expect(warn).not.toHaveBeenCalled()
    expect(spawnClaudeMock).toHaveBeenCalled()
  })

  it('warns rather than going quiet when the pin itself is unreadable', async () => {
    await runImplementAgent(
      baseInput({
        runPolicy: { cliVersion: 'latest', cliVersionStrictness: 'error' }
      })
    )

    expect(warn).toHaveBeenCalledWith(expect.stringContaining('latest'))
    expect(spawnClaudeMock).toHaveBeenCalled()
  })

  it.each([
    ['a failed', undefined],
    ['an unparseable', 'not a version']
  ])(
    'never blocks on %s claude --version, even under error strictness',
    async (_name, version) => {
      runningCliVersion(version)

      await runImplementAgent(
        baseInput({
          runPolicy: { cliVersion: '2.1.220', cliVersionStrictness: 'error' }
        })
      )

      expect(spawnClaudeMock).toHaveBeenCalled()
    }
  )
})

describe('runImplementAgent removed standards directory', () => {
  it('refuses a run whose environment still sets STANDARDS_DIR', async () => {
    // The migration's whole point (shopfloor#27): a consumer's CI sets this,
    // and deleting the field without this check would spend a run's tokens on
    // an agent with less context than its operator believes it has.
    await expect(
      runImplementAgent(
        baseInput({ env: { STANDARDS_DIR: '/tmp/skills/rules' } })
      )
    ).rejects.toThrow(/STANDARDS_DIR/)
    expect(spawnClaudeMock).not.toHaveBeenCalled()
  })

  it('refuses a run still stating the removed field', async () => {
    // No longer type-checks, which is the point: a JS caller, or one compiled
    // against an older version of this package, still reaches the runtime.
    const stated = {
      ...baseInput(),
      standardsDir: '/tmp/skills/rules'
    } as RunImplementAgentConfig

    await expect(runImplementAgent(stated)).rejects.toThrow(/standardsDir/)
    expect(spawnClaudeMock).not.toHaveBeenCalled()
  })
})

describe('runImplementAgent unfilled-prompt precondition', () => {
  it('refuses a prompt still carrying the scaffolder’s sentinel', async () => {
    await expect(
      runImplementAgent(
        baseInput({
          promptTemplate: `Implement issue {{ISSUE_NUMBER}}.\n${ENVIRONMENT_UNFILLED_SENTINEL}: the gate command.`
        })
      )
    ).rejects.toThrow(ENVIRONMENT_UNFILLED_SENTINEL)
    expect(spawnClaudeMock).not.toHaveBeenCalled()
  })

  it('refuses a token nothing substitutes, naming it', async () => {
    await expect(
      runImplementAgent(
        baseInput({ promptTemplate: 'Standards live in {{STANDARDS_DIR}}.' })
      )
    ).rejects.toThrow(/\{\{STANDARDS_DIR\}\}/)
    expect(spawnClaudeMock).not.toHaveBeenCalled()
  })

  it('refuses before probing anything — no tokens, no subprocesses', async () => {
    await expect(
      runImplementAgent(
        baseInput({
          promptTemplate: `${ENVIRONMENT_UNFILLED_SENTINEL}: fill me.`
        })
      )
    ).rejects.toThrow(ImplementAgentError)

    expect(execFileSyncMock).not.toHaveBeenCalled()
    expect(statSyncMock).not.toHaveBeenCalled()
  })

  it('spawns a run whose prompt is filled', async () => {
    await runImplementAgent(
      baseInput({
        promptTemplate: 'Implement {{ISSUE_NUMBER}} on {{BRANCH}}. Run tests.'
      })
    )

    expect(spawnClaudeMock).toHaveBeenCalledOnce()
  })
})

describe('runImplementAgent plugin-directory precondition', () => {
  it('passes each validated entry to the CLI as its own --plugin-dir', async () => {
    await runImplementAgent(
      baseInput({ pluginDirs: ['/plugins/skills', '/plugins/extra.zip'] })
    )

    expect(armedWith().args).toEqual(
      expect.arrayContaining([
        '--plugin-dir',
        '/plugins/skills',
        '--plugin-dir',
        '/plugins/extra.zip'
      ])
    )
  })

  it('takes the list from PLUGIN_DIRS when the input states none', async () => {
    await runImplementAgent(
      baseInput({ env: { PLUGIN_DIRS: '/from-env,/also-env' } })
    )

    expect(armedWith().args).toEqual(
      expect.arrayContaining([
        '--plugin-dir',
        '/from-env',
        '--plugin-dir',
        '/also-env'
      ])
    )
  })

  it('probes a relative entry against the run’s cwd, not this process’s', async () => {
    await runImplementAgent(
      baseInput({ pluginDirs: ['relative/plugin'], cwd: '/repo' })
    )

    expect(statSyncMock).toHaveBeenCalledWith(
      '/repo/relative/plugin/.claude-plugin/plugin.json'
    )
  })

  it('fails before spawning when an entry does not resolve, naming it', async () => {
    statSyncMock.mockImplementation(() => {
      throw new Error('ENOENT')
    })

    await expect(
      runImplementAgent(baseInput({ pluginDirs: ['/plugins/gone'] }))
    ).rejects.toThrow(/\/plugins\/gone/)
    expect(spawnClaudeMock).not.toHaveBeenCalled()
  })

  it('fails before spawning when an entry ships hooks or MCP servers', async () => {
    pluginDirsAreValid({ shipsHooks: true })

    await expect(
      runImplementAgent(baseInput({ pluginDirs: ['/plugins/hooked'] }))
    ).rejects.toThrow(/hooks/)
    expect(spawnClaudeMock).not.toHaveBeenCalled()
  })

  it('falls back to the bundled plugin when no list is stated', async () => {
    await runImplementAgent(baseInput())

    expect(armedWith().args).toEqual(
      expect.arrayContaining(['--plugin-dir', resolveBundledPluginDir()])
    )
  })

  it('replaces the bundled plugin with a stated list rather than adding to it', async () => {
    await runImplementAgent(baseInput({ pluginDirs: ['/plugins/skills'] }))

    expect(armedWith().args).not.toContain(resolveBundledPluginDir())
  })

  it('refuses when the bundled plugin fails validation, naming its path', async () => {
    // Its path is the dependency's, so the package name is what a reader sees.
    statSyncMock.mockImplementation(() => {
      throw new Error('ENOENT')
    })

    await expect(runImplementAgent(baseInput())).rejects.toThrow(
      /galosandoval-skills/
    )
    expect(spawnClaudeMock).not.toHaveBeenCalled()
  })

  it('refuses when the bundled plugin ships hooks or MCP servers', async () => {
    pluginDirsAreValid({ shipsHooks: true })

    await expect(runImplementAgent(baseInput())).rejects.toThrow(/hooks/)
    expect(spawnClaudeMock).not.toHaveBeenCalled()
  })

  it('passes no flag for a deliberately empty list', async () => {
    await runImplementAgent(baseInput({ pluginDirs: [] }))

    expect(armedWith().args).not.toContain('--plugin-dir')
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
      spawnResult({
        killedBy: wallClockKill,
        outputTail: 'the last thing it said'
      })
    )

    await expect(runImplementAgent(baseInput())).rejects.toMatchObject({
      outputTail: 'the last thing it said'
    })
  })

  it.each([
    ['wall-clock', wallClockKill],
    ['idle', idleKill]
  ])(
    'still captures the transcript when the %s guard kills the run',
    async (_name, killedBy) => {
      spawnClaudeMock.mockResolvedValue(spawnResult({ killedBy }))

      await expect(runImplementAgent(baseInput())).rejects.toThrow()
      expect(captureTranscript).toHaveBeenCalled()
    }
  )

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
      prDescription: 'agent',
      iterations: 1
    })
  })
})

/**
 * Spend on the run result (shopfloor#42). The parsing and the fold are tested
 * pure over recorded stream lines in `usage.test.ts`; what these prove is the
 * part that suite cannot — that what the spawn metered reaches the result at
 * all, and that an iterating run reports the sum rather than its last attempt.
 */
describe('runImplementAgent run spend', () => {
  it('reports what the spawn metered', async () => {
    spawnClaudeMock.mockResolvedValue(spent(0.25, 400))

    const result = await runImplementAgent(baseInput())

    expect(result.usage).toEqual(
      expect.objectContaining({
        outputTokens: 400,
        costUsd: 0.25,
        source: 'reported'
      })
    )
  })

  it('sums every iteration, since the loop is what multiplies the spend', async () => {
    gateExits(1, 0)
    spawnClaudeMock
      .mockResolvedValueOnce(spent(0.25, 400))
      .mockResolvedValueOnce(spent(0.75, 600))

    const result = await runImplementAgent(
      baseInput({ runPolicy: { gateCommand: 'bun run verify' } })
    )

    expect(result.iterations).toBe(2)
    expect(result.usage).toEqual(
      expect.objectContaining({ outputTokens: 1000, costUsd: 1 })
    )
  })

  it('reports zeroes rather than nothing when the stream said nothing', async () => {
    const result = await runImplementAgent(baseInput())

    expect(result.usage).toEqual(
      expect.objectContaining({ outputTokens: 0, costUsd: undefined })
    )
  })

  /**
   * A failed run never reaches a run result, and the runs worth costing are
   * exactly the ones that did not finish — so the failure carries the spend
   * out instead.
   */
  describe('on a run that failed', () => {
    /** The `usage` on the `ImplementAgentError` a run threw. */
    const usageOnFailure = async (input: RunImplementAgentConfig) => {
      const error = await runImplementAgent(input).catch((thrown) => thrown)
      expect(error).toBeInstanceOf(ImplementAgentError)
      return (error as ImplementAgentError).usage
    }

    it('carries the spend of a run a guard killed', async () => {
      spawnClaudeMock.mockResolvedValue(
        spawnResult({
          killedBy: { reason: 'idle', budgetMs: 900_000 },
          usage: spent(0.25, 400).usage
        })
      )

      expect(await usageOnFailure(baseInput())).toEqual(
        expect.objectContaining({ outputTokens: 400, costUsd: 0.25 })
      )
    })

    it('carries the spend of a run the CLI exited non-zero on', async () => {
      spawnClaudeMock.mockResolvedValue(
        spawnResult({ exitCode: 2, usage: spent(0.25, 400).usage })
      )

      expect(await usageOnFailure(baseInput())).toEqual(
        expect.objectContaining({ outputTokens: 400 })
      )
    })

    it('carries every iteration’s spend when the attempt ceiling is exhausted', async () => {
      gateExits(1)
      spawnClaudeMock.mockResolvedValue(spent(0.25, 400))

      const usage = await usageOnFailure(
        baseInput({ runPolicy: { gateCommand: 'bun run verify' } })
      )

      // The default ceiling is three attempts, all of them paid for.
      expect(usage).toEqual(
        expect.objectContaining({ outputTokens: 1200, costUsd: 0.75 })
      )
    })

    it('prices the most expensive way to produce nothing — a run that never committed', async () => {
      // `Once`, not a lasting override: implementations survive
      // `clearAllMocks`, and a run reads the commit count exactly once.
      vi.mocked(execSync).mockReturnValueOnce('0\n')
      spawnClaudeMock.mockResolvedValue(spent(0.25, 400))

      expect(await usageOnFailure(baseInput())).toEqual(
        expect.objectContaining({ outputTokens: 400 })
      )
    })

    it('carries nothing for a run that refused before it spawned', async () => {
      const refused = await runImplementAgent(
        baseInput({ runPolicy: { requiredEnvVars: ['DATABASE_URL'] } })
      ).catch((thrown) => thrown)

      expect(refused.message).toContain('DATABASE_URL')
      expect(refused.usage).toBeUndefined()
    })
  })
})

/**
 * The inner loop (shopfloor#40). `evaluateIteration` is tested pure in
 * `iteration.test.ts`; everything here is the wiring that suite cannot prove —
 * that the gate is actually run, that a failure actually respawns, that the
 * next prompt actually carries the failure, and that the wall clock actually
 * bounds the loop rather than each spawn.
 */
describe('runImplementAgent inner loop', () => {
  const gated = (overrides: Partial<RunImplementAgentConfig> = {}) =>
    baseInput({
      ...overrides,
      runPolicy: { gateCommand: 'bun run verify', ...overrides.runPolicy }
    })

  it('runs no gate at all when the caller stated none', async () => {
    const result = await runImplementAgent(baseInput())

    expect(spawnSyncMock).not.toHaveBeenCalled()
    expect(spawnClaudeMock).toHaveBeenCalledOnce()
    expect(result.iterations).toBe(1)
  })

  it('runs the stated gate in the run’s cwd after the spawn', async () => {
    await runImplementAgent(gated())

    expect(spawnSyncMock).toHaveBeenCalledWith(
      'bun run verify',
      expect.objectContaining({ cwd: '/repo', shell: true })
    )
  })

  it('runs the gate on the run’s own env, without the agent’s OAuth token', async () => {
    // The OAuth injection and the ANTHROPIC_API_KEY strip constrain the
    // *agent's* auth; the gate is not the agent, and handing it the token
    // would push a credential into a consumer command with no use for one.
    await runImplementAgent(
      gated({
        env: { DATABASE_URL: 'postgres://x', ANTHROPIC_API_KEY: 'sk-x' }
      })
    )

    const { env } = spawnSyncMock.mock.calls[0][1] as {
      env: Record<string, string | undefined>
    }
    expect(env.DATABASE_URL).toBe('postgres://x')
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined()
  })

  it('spawns once when the gate passes first time', async () => {
    gateExits(0)

    const result = await runImplementAgent(gated())

    expect(spawnClaudeMock).toHaveBeenCalledOnce()
    expect(result.iterations).toBe(1)
  })

  it('spawns again when the gate fails, and stops when it passes', async () => {
    gateExits(1, 0)

    const result = await runImplementAgent(gated())

    expect(spawnClaudeMock).toHaveBeenCalledTimes(2)
    expect(result.iterations).toBe(2)
  })

  it('feeds the gate’s failure into the next prompt', async () => {
    gateExits(1, 0)

    await runImplementAgent(gated())

    expect(spawnNumber(2).prompt).toContain('bun run verify')
    expect(spawnNumber(2).prompt).toContain('gate output 1')
  })

  it('never sends the same prompt twice', async () => {
    gateExits(1, 0)

    await runImplementAgent(gated())

    expect(spawnNumber(2).prompt).not.toBe(spawnNumber(1).prompt)
  })

  it('leaves the first prompt untouched, gate or no gate', async () => {
    gateExits(1, 0)

    await runImplementAgent(gated())

    expect(spawnNumber(1).prompt).toBe('Implement issue 4.')
  })

  it('fails the run when the gate is still red at the iteration ceiling', async () => {
    gateExits(1)

    await expect(
      runImplementAgent(gated({ runPolicy: { maxIterations: 2 } }))
    ).rejects.toThrow(/bun run verify.*2 iteration\(s\)/s)
    expect(spawnClaudeMock).toHaveBeenCalledTimes(2)
  })

  it('carries the gate’s output into that failure', async () => {
    gateExits(1)

    await expect(
      runImplementAgent(gated({ runPolicy: { maxIterations: 1 } }))
    ).rejects.toMatchObject({ outputTail: expect.stringContaining('gate') })
  })

  it('takes the gate command from GATE_COMMAND when the input states none', async () => {
    await runImplementAgent(baseInput({ env: { GATE_COMMAND: 'make check' } }))

    expect(spawnSyncMock).toHaveBeenCalledWith('make check', expect.anything())
  })

  it('arms every spawn with the idle budget in full — idle bounds a spawn', async () => {
    gateExits(1, 0)

    await runImplementAgent(gated({ runPolicy: { idleMinutes: 15 } }))

    expect(spawnNumber(1).idleMs).toBe(15 * 60_000)
    expect(spawnNumber(2).idleMs).toBe(15 * 60_000)
  })

  describe('the wall clock, spent across the loop', () => {
    /** A spawn, or a gate, that takes `ms` of the run's clock. */
    const burns = (ms: number) => () => {
      vi.advanceTimersByTime(ms)
    }

    beforeEach(() => {
      vi.useFakeTimers()
    })

    // Restored here rather than after each assertion, so a failing expectation
    // cannot leak fake timers into the rest of the suite.
    afterEach(() => {
      vi.useRealTimers()
    })

    it('arms the second spawn with what the first one left', async () => {
      gateExits(1, 0)
      spawnClaudeMock.mockImplementation(async () => {
        burns(60_000)()
        return spawnResult()
      })

      await runImplementAgent(gated({ runPolicy: { wallClockMinutes: 45 } }))

      expect(spawnNumber(1).wallClockMs).toBe(45 * 60_000)
      expect(spawnNumber(2).wallClockMs).toBe(44 * 60_000)
    })

    it('charges the gate’s own time to the run, not to nobody', async () => {
      // A gate is normally the whole test suite. Billing only the spawn would
      // let N iterations overrun the stated ceiling by N gates.
      let gateRuns = 0
      spawnSyncMock.mockImplementation(() => {
        burns(5 * 60_000)()
        return { status: gateRuns++ === 0 ? 1 : 0, stdout: 'gate', stderr: '' }
      })

      await runImplementAgent(gated({ runPolicy: { wallClockMinutes: 45 } }))

      expect(spawnNumber(2).wallClockMs).toBe(40 * 60_000)
    })

    it('fails rather than spawning into a spent wall clock', async () => {
      gateExits(1)
      spawnClaudeMock.mockImplementation(async () => {
        burns(60_000)()
        return spawnResult()
      })

      await expect(
        runImplementAgent(
          gated({ runPolicy: { wallClockMinutes: 1, maxIterations: 5 } })
        )
      ).rejects.toThrow(/wall-clock/)
      expect(spawnClaudeMock).toHaveBeenCalledOnce()
    })

    it('stops before a spawn too small to be worth starting', async () => {
      // 90s of budget, 60s spent: the 30s left would only buy a spawn the
      // wall-clock guard kills, reported as a runaway rather than as the spent
      // budget it is.
      gateExits(1)
      spawnClaudeMock.mockImplementation(async () => {
        burns(60_000)()
        return spawnResult()
      })

      await expect(
        runImplementAgent(
          gated({ runPolicy: { wallClockMinutes: 1.5, maxIterations: 5 } })
        )
      ).rejects.toThrow(/wall-clock budget is spent/)
      expect(spawnClaudeMock).toHaveBeenCalledOnce()
    })
  })

  it('does not iterate on a runaway kill — only the gate iterates', async () => {
    gateExits(1, 0)
    spawnClaudeMock.mockResolvedValue(
      spawnResult({ killedBy: { reason: 'idle', budgetMs: 15 * 60_000 } })
    )

    await expect(runImplementAgent(gated())).rejects.toThrow(/idle guard/)
    expect(spawnClaudeMock).toHaveBeenCalledOnce()
    expect(spawnSyncMock).not.toHaveBeenCalled()
  })

  it('does not iterate on a non-zero CLI exit', async () => {
    gateExits(1, 0)
    spawnClaudeMock.mockResolvedValue(spawnResult({ exitCode: 2 }))

    await expect(runImplementAgent(gated())).rejects.toThrow(/status 2/)
    expect(spawnClaudeMock).toHaveBeenCalledOnce()
  })

  it('captures the transcript of the last iteration', async () => {
    gateExits(1, 0)

    const result = await runImplementAgent(gated())

    expect(captureTranscript).toHaveBeenCalledTimes(2)
    expect(result.transcriptCaptured).toBe(true)
  })

  it('keeps each failed attempt’s transcript before overwriting it', async () => {
    // The failed attempts are the ones worth reading, and each is about to be
    // replaced by the attempt that fixed it.
    gateExits(1, 1, 0)

    await runImplementAgent(
      gated({
        transcriptFile: '/tmp/out/transcript.jsonl',
        runPolicy: { maxIterations: 3 }
      })
    )

    expect(preserveIterationTranscript).toHaveBeenCalledWith(
      '/tmp/out/transcript.jsonl',
      1
    )
    expect(preserveIterationTranscript).toHaveBeenCalledWith(
      '/tmp/out/transcript.jsonl',
      2
    )
  })

  it('keeps nothing extra for a run that never iterated', async () => {
    await runImplementAgent(gated())

    expect(preserveIterationTranscript).not.toHaveBeenCalled()
  })

  it('keeps no copy of the attempt that finished the run', async () => {
    // It is still in `transcriptFile`; a second copy under a different name
    // would be the same session twice.
    gateExits(1, 0)

    await runImplementAgent(gated())

    expect(preserveIterationTranscript).toHaveBeenCalledOnce()
  })
})
