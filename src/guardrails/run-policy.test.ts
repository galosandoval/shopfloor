import {
  DEFAULT_RUN_POLICY,
  IDLE_MINUTES_ENV_VAR,
  WALL_CLOCK_MINUTES_ENV_VAR,
  findMissingEnvVars,
  resolveIdleMs,
  resolveWallClockMs,
  type RunPolicyConfig
} from './run-policy'

const REQUIRED_ENV_VARS = ['CLAUDE_CODE_OAUTH_TOKEN', 'DATABASE_URL'] as const

const baseConfig: RunPolicyConfig = {
  model: 'claude-opus-4-8',
  maxTurns: 150,
  cliVersion: '2.1.208',
  idleMinutes: 15,
  wallClockMinutes: 45,
  requiredEnvVars: REQUIRED_ENV_VARS
}

/** A process env where every required var is present and non-empty. */
function fullEnv(): Record<string, string | undefined> {
  return Object.fromEntries(REQUIRED_ENV_VARS.map((name) => [name, 'set']))
}

describe('run-policy contract', () => {
  describe('findMissingEnvVars', () => {
    it('returns no missing names when every required var is present', () => {
      expect(findMissingEnvVars(REQUIRED_ENV_VARS, fullEnv())).toEqual([])
    })

    it('names every missing required var, in declaration order', () => {
      expect(findMissingEnvVars(REQUIRED_ENV_VARS, {})).toEqual([
        ...REQUIRED_ENV_VARS
      ])
    })

    it('treats an empty string as missing', () => {
      const env = fullEnv()
      env.CLAUDE_CODE_OAUTH_TOKEN = ''
      expect(findMissingEnvVars(REQUIRED_ENV_VARS, env)).toEqual([
        'CLAUDE_CODE_OAUTH_TOKEN'
      ])
    })

    it('is caller-supplied — an empty list is never missing anything', () => {
      expect(findMissingEnvVars([], {})).toEqual([])
    })
  })

  describe('budget resolution', () => {
    it('falls back to the config default when unset', () => {
      expect(resolveIdleMs(baseConfig, {})).toBe(15 * 60_000)
      expect(resolveWallClockMs(baseConfig, {})).toBe(45 * 60_000)
    })

    it('honors a positive numeric env override', () => {
      expect(resolveIdleMs(baseConfig, { [IDLE_MINUTES_ENV_VAR]: '3' })).toBe(
        3 * 60_000
      )
      expect(
        resolveWallClockMs(baseConfig, { [WALL_CLOCK_MINUTES_ENV_VAR]: '20' })
      ).toBe(20 * 60_000)
    })

    it('falls back when the override is empty, non-numeric, or non-positive', () => {
      expect(resolveIdleMs(baseConfig, { [IDLE_MINUTES_ENV_VAR]: '' })).toBe(
        15 * 60_000
      )
      expect(
        resolveIdleMs(baseConfig, { [IDLE_MINUTES_ENV_VAR]: 'soon' })
      ).toBe(15 * 60_000)
      expect(resolveIdleMs(baseConfig, { [IDLE_MINUTES_ENV_VAR]: '0' })).toBe(
        15 * 60_000
      )
      expect(
        resolveWallClockMs(baseConfig, {
          [WALL_CLOCK_MINUTES_ENV_VAR]: '-5'
        })
      ).toBe(45 * 60_000)
    })

    it('reads its own config field, not a hardcoded default', () => {
      const config = { ...baseConfig, idleMinutes: 7, wallClockMinutes: 90 }
      expect(resolveIdleMs(config, {})).toBe(7 * 60_000)
      expect(resolveWallClockMs(config, {})).toBe(90 * 60_000)
    })

    it('falls back to the package default idle budget when the config omits one', () => {
      expect(resolveIdleMs({}, {})).toBe(DEFAULT_RUN_POLICY.idleMinutes * 60_000)
    })

    it('still honors the idle override when the config omits a budget', () => {
      expect(resolveIdleMs({}, { [IDLE_MINUTES_ENV_VAR]: '4' })).toBe(4 * 60_000)
    })

    it('reports no wall-clock budget when neither config nor env sets one', () => {
      expect(resolveWallClockMs({}, {})).toBeUndefined()
    })

    it('honors a wall-clock override even when the config omits a budget', () => {
      expect(
        resolveWallClockMs({}, { [WALL_CLOCK_MINUTES_ENV_VAR]: '20' })
      ).toBe(20 * 60_000)
    })
  })

  describe('DEFAULT_RUN_POLICY', () => {
    it('requires no env vars of its own', () => {
      expect(DEFAULT_RUN_POLICY.requiredEnvVars).toEqual([])
    })

    it('names no model, leaving the choice to the Claude CLI', () => {
      expect(DEFAULT_RUN_POLICY.model).toBeUndefined()
    })

    it('caps turns and arms the idle guard', () => {
      expect(DEFAULT_RUN_POLICY.maxTurns).toBeGreaterThan(0)
      expect(DEFAULT_RUN_POLICY.idleMinutes).toBeGreaterThan(0)
    })
  })
})
