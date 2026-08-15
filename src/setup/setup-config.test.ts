import {
  DEFAULT_PAT_SECRET,
  DEFAULT_PROMPT_FILE,
  DEFAULT_WORKFLOW_FILE,
  OAUTH_TOKEN_SECRET,
  resolveDoctorConfig,
  resolveInitConfig
} from './setup-config'

describe('resolveDoctorConfig', () => {
  it('requires the Anthropic token and the PAT when nothing states otherwise', () => {
    const resolved = resolveDoctorConfig({}, {})
    expect(resolved.requiredSecrets).toEqual([
      OAUTH_TOKEN_SECRET,
      DEFAULT_PAT_SECRET
    ])
    expect(resolved.patSecret).toBe(DEFAULT_PAT_SECRET)
    expect(resolved.workflowFile).toBe(DEFAULT_WORKFLOW_FILE)
  })

  it('follows a renamed PAT secret into the required list', () => {
    expect(
      resolveDoctorConfig({ patSecret: 'LOOP_PAT' }, {}).requiredSecrets
    ).toEqual([OAUTH_TOKEN_SECRET, 'LOOP_PAT'])
  })

  it('lets a stated list replace the defaults outright', () => {
    expect(
      resolveDoctorConfig({}, { REQUIRED_SECRETS: 'ONE, TWO' }).requiredSecrets
    ).toEqual(['ONE', 'TWO'])
  })

  it('prefers explicit input over the environment', () => {
    const resolved = resolveDoctorConfig(
      { repo: 'me/stated', workflowFile: 'stated.yml', cliVersion: '2.2.0' },
      {
        GITHUB_REPOSITORY: 'me/env',
        WORKFLOW_FILE: 'env.yml',
        CLI_VERSION: '2.1.220'
      }
    )
    expect(resolved.repo).toBe('me/stated')
    expect(resolved.workflowFile).toBe('stated.yml')
    expect(resolved.cliVersion).toBe('2.2.0')
  })

  it('reads the environment when nothing was stated', () => {
    const resolved = resolveDoctorConfig(
      {},
      {
        GITHUB_REPOSITORY: 'me/env',
        PROMPT_FILE: './prompt.md',
        CLI_VERSION: '2.1.220',
        AGENT_PAT_SECRET: 'LOOP_PAT'
      }
    )
    expect(resolved.repo).toBe('me/env')
    expect(resolved.promptFile).toBe('./prompt.md')
    expect(resolved.cliVersion).toBe('2.1.220')
    expect(resolved.patSecret).toBe('LOOP_PAT')
  })

  it('omits what nothing answered rather than fabricating it', () => {
    const resolved = resolveDoctorConfig({}, {})
    expect(resolved.repo).toBeUndefined()
    expect(resolved.promptFile).toBeUndefined()
    expect(resolved.cliVersion).toBeUndefined()
  })
})

describe('resolveInitConfig', () => {
  it('has a prompt path to scaffold at where doctor has none to judge', () => {
    expect(resolveInitConfig({}, {}).promptFile).toBe(DEFAULT_PROMPT_FILE)
    expect(resolveDoctorConfig({}, {}).promptFile).toBeUndefined()
  })

  it('resolves a stated prompt path over the environment, and both over the default', () => {
    expect(
      resolveInitConfig({ promptFile: 'stated.md' }, { PROMPT_FILE: 'env.md' })
        .promptFile
    ).toBe('stated.md')
    expect(resolveInitConfig({}, { PROMPT_FILE: 'env.md' }).promptFile).toBe(
      'env.md'
    )
  })

  it('resolves everything else exactly as the doctor does', () => {
    const env = { REQUIRED_SECRETS: 'ONE,TWO', WORKFLOW_FILE: 'loop.yml' }
    const { promptFile, ...shared } = resolveInitConfig({}, env)
    expect(shared).toEqual(resolveDoctorConfig({}, env))
    expect(promptFile).toBe(DEFAULT_PROMPT_FILE)
  })
})
