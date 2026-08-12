/**
 * The orchestrator's own wiring: that the budgets it resolves reach the spawn,
 * that each guard's kill becomes the right failure, and that the pre-spawn
 * preconditions (shopfloor#5) refuse before any tokens are spent. The
 * resolvers are tested pure elsewhere — a suite that stops there stays green
 * while a budget is never read by a run, which is the coverage gap
 * shopfloor#4 exists to close, so everything here goes through
 * `runImplementAgent` itself.
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
// Hoisted so the stubs a test reprograms are held as plain `vi.fn()`s: these
// built-ins are heavily overloaded, and addressing them through `vi.mocked`
// would mean casting past an overload set to stub one return.
const { execFileSyncMock, statSyncMock, readFileSyncMock } = vi.hoisted(() => ({
  execFileSyncMock: vi.fn(),
  statSyncMock: vi.fn(),
  readFileSyncMock: vi.fn()
}))

vi.mock('node:child_process', () => ({
  // The post-run commit count; a fresh mock per test overrides it where the
  // number is what's under test.
  execSync: vi.fn(() => '2\n'),
  execFileSync: execFileSyncMock,
  spawn: vi.fn()
}))
vi.mock('node:fs', () => ({
  // The command-guard hook resolves against `dist/`, which a source-run test
  // has no copy of, and the PR description is written by the run itself.
  existsSync: vi.fn(() => true),
  readFileSync: readFileSyncMock,
  writeFileSync: vi.fn(),
  // A stated `standardsDir` resolves to a real directory unless a test says
  // otherwise.
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
 * A filesystem where every stated plugin directory is a valid plugin: a
 * manifest declaring one skill that exists, and neither `hooks/` nor
 * `.mcp.json`. The real `runPluginDirsCheck` runs against this — stubbing the
 * check itself would prove only that a stub was called.
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

/** A `standardsDir` that resolves to nothing, as a missing path or a file. */
function standardsDirIs(kind: 'missing' | 'a file') {
  statSyncMock.mockImplementation(() => {
    if (kind === 'missing') throw new Error('ENOENT')
    return { isDirectory: () => false }
  })
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

function spawnResult(
  overrides: Partial<SpawnClaudeResult> = {}
): SpawnClaudeResult {
  return { exitCode: 0, killedBy: null, outputTail: '', ...overrides }
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(captureTranscript).mockReturnValue(true)
  spawnClaudeMock.mockResolvedValue(spawnResult())
  // Implementations survive `clearAllMocks`, so every per-test override above
  // is restored to the happy default here rather than leaking into the next.
  runningCliVersion('2.1.220')
  statSyncMock.mockImplementation(() => ({ isDirectory: () => true }))
  readFileSyncMock.mockReturnValue('an agent-written PR description')
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

describe('runImplementAgent standards-directory precondition', () => {
  it.each([['missing'], ['a file']] as const)(
    'fails before spawning when the standards dir is %s, naming the path',
    async (kind) => {
      standardsDirIs(kind)

      await expect(
        runImplementAgent(baseInput({ standardsDir: '/tmp/skills/rules' }))
      ).rejects.toThrow(/\/tmp\/skills\/rules/)
      expect(spawnClaudeMock).not.toHaveBeenCalled()
    }
  )

  it('skips the check silently when no standards dir is stated', async () => {
    standardsDirIs('missing')

    await runImplementAgent(baseInput())

    expect(spawnClaudeMock).toHaveBeenCalled()
  })

  it('spawns when the standards dir resolves to a directory', async () => {
    await runImplementAgent(baseInput({ standardsDir: '/tmp/skills/rules' }))

    expect(spawnClaudeMock).toHaveBeenCalled()
  })

  it('resolves a relative standards dir against the run’s cwd, not this process’s', async () => {
    // The agent reads the path from inside the run's checkout, so validating
    // it anywhere else would pass or fail on a different directory entirely.
    await runImplementAgent(
      baseInput({ standardsDir: 'skills/rules', cwd: '/repo' })
    )

    expect(statSyncMock).toHaveBeenCalledWith('/repo/skills/rules')
  })
})

describe('runImplementAgent plugin-directory precondition', () => {
  beforeEach(() => {
    pluginDirsAreValid()
  })

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

  it('passes no flag when no list is stated', async () => {
    await runImplementAgent(baseInput())

    expect(armedWith().args).not.toContain('--plugin-dir')
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
      prDescription: 'agent'
    })
  })
})
