import * as os from 'node:os'
import * as path from 'node:path'
import { DEFAULT_CLI_VERSION_STRICTNESS } from '../guardrails/cli-version'
import { DEFAULT_RUN_POLICY } from '../guardrails/run-policy'
import { resolveImplementConfig, type RunImplementAgentConfig } from './config'

const TOKEN = 'sk-oauth-test'

function baseInput(
  overrides: Partial<RunImplementAgentConfig> = {}
): RunImplementAgentConfig {
  return {
    issueNumber: '123',
    promptTemplate: 'Implement #{{ISSUE_NUMBER}}.',
    ...overrides
  }
}

/** The minimum environment any run needs: the OAuth token and nothing else. */
function baseEnv(
  overrides: Record<string, string | undefined> = {}
): Record<string, string | undefined> {
  return { CLAUDE_CODE_OAUTH_TOKEN: TOKEN, ...overrides }
}

describe('resolveImplementConfig', () => {
  describe('required inputs', () => {
    it('resolves a run from nothing but an issue number, a prompt, and a token', () => {
      const config = resolveImplementConfig(baseInput(), baseEnv())

      expect(config.issueNumber).toBe('123')
      expect(config.promptTemplate).toBe('Implement #{{ISSUE_NUMBER}}.')
      expect(config.claudeCodeOAuthToken).toBe(TOKEN)
    })

    it('takes the issue number from the environment when the input omits it', () => {
      const config = resolveImplementConfig(
        baseInput({ issueNumber: undefined }),
        baseEnv({ ISSUE_NUMBER: '77' })
      )

      expect(config.issueNumber).toBe('77')
    })

    it('names the issue number when it is nowhere to be found', () => {
      expect(() =>
        resolveImplementConfig(baseInput({ issueNumber: undefined }), baseEnv())
      ).toThrow(/ISSUE_NUMBER/)
    })

    it('names the OAuth token when it is nowhere to be found', () => {
      expect(() => resolveImplementConfig(baseInput(), {})).toThrow(
        /CLAUDE_CODE_OAUTH_TOKEN/
      )
    })

    it('prefers an explicitly passed token over the environment', () => {
      const config = resolveImplementConfig(
        baseInput({ claudeCodeOAuthToken: 'sk-explicit' }),
        baseEnv()
      )

      expect(config.claudeCodeOAuthToken).toBe('sk-explicit')
    })
  })

  describe('GitHub environment inference', () => {
    it('infers the branch from GITHUB_REF_NAME', () => {
      const config = resolveImplementConfig(
        baseInput(),
        baseEnv({ GITHUB_REF_NAME: 'agent/issue-123' })
      )

      expect(config.branch).toBe('agent/issue-123')
    })

    it('prefers an explicit branch over the environment', () => {
      const config = resolveImplementConfig(
        baseInput({ branch: 'explicit-branch' }),
        baseEnv({ BRANCH: 'env-branch', GITHUB_REF_NAME: 'ref-branch' })
      )

      expect(config.branch).toBe('explicit-branch')
    })

    it('prefers BRANCH over GITHUB_REF_NAME', () => {
      const config = resolveImplementConfig(
        baseInput(),
        baseEnv({ BRANCH: 'env-branch', GITHUB_REF_NAME: 'ref-branch' })
      )

      expect(config.branch).toBe('env-branch')
    })

    it('leaves the branch unresolved for the git probe when nothing states one', () => {
      const config = resolveImplementConfig(baseInput(), baseEnv())

      expect(config.branch).toBeUndefined()
    })

    it('infers the repository from GITHUB_REPOSITORY', () => {
      const config = resolveImplementConfig(
        baseInput(),
        baseEnv({ GITHUB_REPOSITORY: 'me/app' })
      )

      expect(config.repo).toBe('me/app')
    })

    it('leaves the issue title unresolved for the gh probe when nothing states one', () => {
      const config = resolveImplementConfig(baseInput(), baseEnv())

      expect(config.issueTitle).toBeUndefined()
    })

    it('takes the issue title from ISSUE_TITLE when set', () => {
      const config = resolveImplementConfig(
        baseInput(),
        baseEnv({ ISSUE_TITLE: 'Add pantry filter' })
      )

      expect(config.issueTitle).toBe('Add pantry filter')
    })
  })

  describe('the removed standards directory', () => {
    /** A caller still passing the removed field, which no longer type-checks. */
    function statingStandardsDir(
      standardsDir: string
    ): RunImplementAgentConfig {
      return { ...baseInput(), standardsDir } as RunImplementAgentConfig
    }

    it('refuses a stated standards directory, naming the replacement', () => {
      expect(() =>
        resolveImplementConfig(
          statingStandardsDir('/tmp/skills/rules'),
          baseEnv()
        )
      ).toThrow(/standardsDir.*pluginDirs/s)
    })

    it('refuses a non-empty STANDARDS_DIR, which no type error would catch', () => {
      expect(() =>
        resolveImplementConfig(
          baseInput(),
          baseEnv({ STANDARDS_DIR: '/tmp/skills/rules' })
        )
      ).toThrow(/STANDARDS_DIR.*PLUGIN_DIRS/s)
    })

    it.each([
      ['a stated empty string', statingStandardsDir(''), baseEnv()],
      ['no field at all', baseInput(), baseEnv()],
      ['an empty STANDARDS_DIR', baseInput(), baseEnv({ STANDARDS_DIR: '' })]
    ])(
      'resolves a run with %s — empty still means "deliberately skip"',
      (_name, input, env) => {
        expect(resolveImplementConfig(input, env).issueNumber).toBe('123')
      }
    )
  })

  describe('plugin directories', () => {
    it('leaves the list unstated when neither input nor environment names one', () => {
      const config = resolveImplementConfig(baseInput(), baseEnv())

      expect(config.pluginDirs).toBeUndefined()
    })

    it('distinguishes an explicitly empty list from an unstated one', () => {
      const config = resolveImplementConfig(
        baseInput({ pluginDirs: [] }),
        baseEnv()
      )

      expect(config.pluginDirs).toEqual([])
    })

    it('reads an empty PLUGIN_DIRS as deliberately no plugins, not as unstated', () => {
      const config = resolveImplementConfig(
        baseInput(),
        baseEnv({ PLUGIN_DIRS: '' })
      )

      expect(config.pluginDirs).toEqual([])
    })

    it('splits PLUGIN_DIRS on commas, trimming each entry', () => {
      const config = resolveImplementConfig(
        baseInput(),
        baseEnv({ PLUGIN_DIRS: '/a/skills, /b/skills.zip' })
      )

      expect(config.pluginDirs).toEqual(['/a/skills', '/b/skills.zip'])
    })

    it('prefers a stated list over the environment', () => {
      const config = resolveImplementConfig(
        baseInput({ pluginDirs: ['/stated'] }),
        baseEnv({ PLUGIN_DIRS: '/from-env' })
      )

      expect(config.pluginDirs).toEqual(['/stated'])
    })
  })

  describe('output paths', () => {
    it('derives every run output from the OS tmpdir by default', () => {
      const config = resolveImplementConfig(baseInput(), baseEnv())

      expect(config.prDescriptionFile).toBe(
        path.join(os.tmpdir(), 'pr_description.txt')
      )
      expect(config.verifyReportFile).toBe(
        path.join(os.tmpdir(), 'verify_report.md')
      )
      expect(config.transcriptFile).toBe(
        path.join(os.tmpdir(), 'transcript.jsonl')
      )
      expect(config.failureReasonFile).toBe(
        path.join(os.tmpdir(), 'failure_reason.txt')
      )
    })

    it('derives every run output from an explicit outputDir', () => {
      const config = resolveImplementConfig(
        baseInput({ outputDir: '/out' }),
        baseEnv()
      )

      expect(config.prDescriptionFile).toBe(
        path.join('/out', 'pr_description.txt')
      )
      expect(config.verifyReportFile).toBe(
        path.join('/out', 'verify_report.md')
      )
      expect(config.transcriptFile).toBe(path.join('/out', 'transcript.jsonl'))
      expect(config.failureReasonFile).toBe(
        path.join('/out', 'failure_reason.txt')
      )
    })

    it('derives every run output from OUTPUT_DIR', () => {
      const config = resolveImplementConfig(
        baseInput(),
        baseEnv({ OUTPUT_DIR: '/env-out' })
      )

      expect(config.prDescriptionFile).toBe(
        path.join('/env-out', 'pr_description.txt')
      )
      expect(config.transcriptFile).toBe(
        path.join('/env-out', 'transcript.jsonl')
      )
    })

    it('lets each output path be overridden individually', () => {
      const config = resolveImplementConfig(
        baseInput({
          outputDir: '/out',
          prDescriptionFile: '/elsewhere/pr.txt',
          verifyReportFile: '/elsewhere/verify.md',
          transcriptFile: '/elsewhere/transcript.jsonl',
          failureReasonFile: '/elsewhere/failure.txt'
        }),
        baseEnv()
      )

      expect(config.prDescriptionFile).toBe('/elsewhere/pr.txt')
      expect(config.verifyReportFile).toBe('/elsewhere/verify.md')
      expect(config.transcriptFile).toBe('/elsewhere/transcript.jsonl')
      expect(config.failureReasonFile).toBe('/elsewhere/failure.txt')
    })

    it('scopes the screenshots dir to the issue, repo-relative', () => {
      const config = resolveImplementConfig(baseInput(), baseEnv())

      expect(config.screenshotsDir).toBe('.agent/verify/issue-123')
    })

    it('keeps the screenshots dir put when outputDir moves — those files get committed', () => {
      const config = resolveImplementConfig(
        baseInput({ outputDir: '/out' }),
        baseEnv()
      )

      expect(config.screenshotsDir).toBe('.agent/verify/issue-123')
    })

    it('lets the screenshots dir be overridden by input and by env', () => {
      expect(
        resolveImplementConfig(
          baseInput({ screenshotsDir: 'shots' }),
          baseEnv({ SCREENSHOTS_DIR: 'env-shots' })
        ).screenshotsDir
      ).toBe('shots')
      expect(
        resolveImplementConfig(
          baseInput(),
          baseEnv({ SCREENSHOTS_DIR: 'env-shots' })
        ).screenshotsDir
      ).toBe('env-shots')
    })

    it("defaults the projects dir to Claude Code's session store", () => {
      const config = resolveImplementConfig(baseInput(), baseEnv())

      expect(config.projectsDir).toBe(
        path.join(os.homedir(), '.claude', 'projects')
      )
    })

    it('lets the projects dir be overridden by input and by env', () => {
      expect(
        resolveImplementConfig(
          baseInput({ projectsDir: '/projects' }),
          baseEnv({ PROJECTS_DIR: '/env-projects' })
        ).projectsDir
      ).toBe('/projects')
      expect(
        resolveImplementConfig(
          baseInput(),
          baseEnv({ PROJECTS_DIR: '/env-projects' })
        ).projectsDir
      ).toBe('/env-projects')
    })
  })

  describe('run policy', () => {
    it('applies the package defaults when the caller states no policy', () => {
      const { runPolicy } = resolveImplementConfig(baseInput(), baseEnv())

      expect(runPolicy).toEqual(DEFAULT_RUN_POLICY)
    })

    it('names no model, so the invocation can omit the flag', () => {
      const { runPolicy } = resolveImplementConfig(baseInput(), baseEnv())

      expect(runPolicy.model).toBeUndefined()
    })

    it('requires no env vars of its own', () => {
      const { runPolicy } = resolveImplementConfig(baseInput(), baseEnv())

      expect(runPolicy.requiredEnvVars).toEqual([])
    })

    it('merges a single stated field over the defaults, keeping the rest', () => {
      const { runPolicy } = resolveImplementConfig(
        baseInput({ runPolicy: { maxTurns: 42 } }),
        baseEnv()
      )

      expect(runPolicy.maxTurns).toBe(42)
      expect(runPolicy.idleMinutes).toBe(DEFAULT_RUN_POLICY.idleMinutes)
      expect(runPolicy.requiredEnvVars).toEqual([])
    })

    it('reads each policy field from the environment', () => {
      const { runPolicy } = resolveImplementConfig(
        baseInput(),
        baseEnv({
          MODEL: 'claude-sonnet-5',
          MAX_TURNS: '80',
          MAX_ITERATIONS: '5',
          IDLE_MINUTES: '9',
          CLI_VERSION: '2.1.208',
          WALL_CLOCK_MINUTES: '45',
          GATE_COMMAND: 'bun run typecheck && bun run test',
          REQUIRED_ENV_VARS: 'DATABASE_URL, GH_TOKEN'
        })
      )

      expect(runPolicy).toEqual({
        model: 'claude-sonnet-5',
        maxTurns: 80,
        maxIterations: 5,
        idleMinutes: 9,
        cliVersion: '2.1.208',
        cliVersionStrictness: DEFAULT_CLI_VERSION_STRICTNESS,
        wallClockMinutes: 45,
        gateCommand: 'bun run typecheck && bun run test',
        requiredEnvVars: ['DATABASE_URL', 'GH_TOKEN']
      })
    })

    it('states no gate command, so a default run is single-shot', () => {
      const { runPolicy } = resolveImplementConfig(baseInput(), baseEnv())

      expect(runPolicy.gateCommand).toBeUndefined()
    })

    it('prefers a stated gate command over the environment', () => {
      const { runPolicy } = resolveImplementConfig(
        baseInput({ runPolicy: { gateCommand: 'npm test' } }),
        baseEnv({ GATE_COMMAND: 'bun test' })
      )

      expect(runPolicy.gateCommand).toBe('npm test')
    })

    it('reads an empty GATE_COMMAND as no gate at all', () => {
      const { runPolicy } = resolveImplementConfig(
        baseInput(),
        baseEnv({ GATE_COMMAND: '' })
      )

      expect(runPolicy.gateCommand).toBeUndefined()
    })

    it('prefers a stated iteration budget over the environment', () => {
      const { runPolicy } = resolveImplementConfig(
        baseInput({ runPolicy: { maxIterations: 2 } }),
        baseEnv({ MAX_ITERATIONS: '9' })
      )

      expect(runPolicy.maxIterations).toBe(2)
    })

    it('ignores a non-numeric iteration budget from the environment', () => {
      const { runPolicy } = resolveImplementConfig(
        baseInput(),
        baseEnv({ MAX_ITERATIONS: 'as many as it takes' })
      )

      expect(runPolicy.maxIterations).toBe(DEFAULT_RUN_POLICY.maxIterations)
    })

    it('prefers a stated policy field over the environment', () => {
      const { runPolicy } = resolveImplementConfig(
        baseInput({ runPolicy: { model: 'claude-opus-5' } }),
        baseEnv({ MODEL: 'claude-sonnet-5' })
      )

      expect(runPolicy.model).toBe('claude-opus-5')
    })

    it('ignores a non-numeric turn cap from the environment', () => {
      const { runPolicy } = resolveImplementConfig(
        baseInput(),
        baseEnv({ MAX_TURNS: 'lots' })
      )

      expect(runPolicy.maxTurns).toBe(DEFAULT_RUN_POLICY.maxTurns)
    })

    it('defaults the CLI-version strictness to a non-blocking warn', () => {
      const { runPolicy } = resolveImplementConfig(baseInput(), baseEnv())

      expect(runPolicy.cliVersionStrictness).toBe(
        DEFAULT_CLI_VERSION_STRICTNESS
      )
    })

    it('reads the CLI-version strictness from the environment', () => {
      const { runPolicy } = resolveImplementConfig(
        baseInput(),
        baseEnv({ CLI_VERSION_STRICTNESS: 'error' })
      )

      expect(runPolicy.cliVersionStrictness).toBe('error')
    })

    it('prefers a stated CLI-version strictness over the environment', () => {
      const { runPolicy } = resolveImplementConfig(
        baseInput({ runPolicy: { cliVersionStrictness: 'off' } }),
        baseEnv({ CLI_VERSION_STRICTNESS: 'error' })
      )

      expect(runPolicy.cliVersionStrictness).toBe('off')
    })

    it('falls back to the default on an unrecognized strictness, rather than refusing the run', () => {
      const { runPolicy } = resolveImplementConfig(
        baseInput(),
        baseEnv({ CLI_VERSION_STRICTNESS: 'strict' })
      )

      expect(runPolicy.cliVersionStrictness).toBe(
        DEFAULT_CLI_VERSION_STRICTNESS
      )
    })

    it('reads an empty REQUIRED_ENV_VARS as requiring nothing', () => {
      const { runPolicy } = resolveImplementConfig(
        baseInput(),
        baseEnv({ REQUIRED_ENV_VARS: ' , ' })
      )

      expect(runPolicy.requiredEnvVars).toEqual([])
    })
  })
})
