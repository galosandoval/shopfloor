import {
  evaluateAuthorization,
  isProbeableTarget,
  SPENDING_PERMISSIONS,
  type AuthorizationInput
} from './authorization'

const input = (overrides: Partial<AuthorizationInput> = {}) =>
  ({
    actor: 'galosandoval',
    repo: 'galosandoval/recipe-chat',
    probe: { answered: true, permission: 'admin' },
    ...overrides
  }) satisfies AuthorizationInput

describe('evaluateAuthorization', () => {
  describe('permitted', () => {
    it.each(SPENDING_PERMISSIONS)('authorizes %s', (permission) => {
      const verdict = evaluateAuthorization(
        input({ probe: { answered: true, permission } })
      )

      expect(verdict).toEqual({ authorized: true, permission })
    })

    it('reads the permission case- and whitespace-insensitively', () => {
      const verdict = evaluateAuthorization(
        input({ probe: { answered: true, permission: ' Admin\n' } })
      )

      expect(verdict).toEqual({ authorized: true, permission: 'admin' })
    })
  })

  describe('not permitted', () => {
    it.each(['read', 'triage', 'none'])(
      'refuses %s as not-permitted',
      (permission) => {
        const verdict = evaluateAuthorization(
          input({ actor: 'drive-by', probe: { answered: true, permission } })
        )

        expect(verdict).toMatchObject({
          authorized: false,
          refusal: 'not-permitted'
        })
      }
    )

    it('names the actor, the permission they have, and what would unblock them', () => {
      const verdict = evaluateAuthorization(
        input({
          actor: 'drive-by',
          probe: { answered: true, permission: 'read' }
        })
      )

      if (verdict.authorized) throw new Error('expected a refusal')
      expect(verdict.reason).toContain('drive-by')
      expect(verdict.reason).toContain('read')
      expect(verdict.reason).toContain('galosandoval/recipe-chat')
      expect(verdict.reason).toContain('write')
    })
  })

  describe('undetermined', () => {
    it('refuses an unreadable probe', () => {
      const verdict = evaluateAuthorization(
        input({ probe: { answered: false, detail: 'gh: command not found' } })
      )

      expect(verdict).toMatchObject({
        authorized: false,
        refusal: 'undetermined'
      })
    })

    it('carries the probe failure into the reason', () => {
      const verdict = evaluateAuthorization(
        input({ probe: { answered: false, detail: 'HTTP 404: Not Found' } })
      )

      if (verdict.authorized) throw new Error('expected a refusal')
      expect(verdict.reason).toContain('HTTP 404: Not Found')
      expect(verdict.reason).toContain('galosandoval')
    })

    it('refuses when no probe was taken at all', () => {
      const verdict = evaluateAuthorization(input({ probe: undefined }))

      if (verdict.authorized) throw new Error('expected a refusal')
      expect(verdict.refusal).toBe('undetermined')
      expect(verdict.reason).toContain('never probed')
    })

    it('refuses a permission string it does not recognize rather than guessing', () => {
      const verdict = evaluateAuthorization(
        input({ probe: { answered: true, permission: 'custom-role-7' } })
      )

      expect(verdict).toMatchObject({
        authorized: false,
        refusal: 'undetermined'
      })
    })

    it('refuses an empty permission', () => {
      const verdict = evaluateAuthorization(
        input({ probe: { answered: true, permission: '   ' } })
      )

      expect(verdict).toMatchObject({
        authorized: false,
        refusal: 'undetermined'
      })
    })

    it('refuses when the actor is unstated — an unnamed actor is uncertainty too', () => {
      const verdict = evaluateAuthorization(input({ actor: '  ' }))

      expect(verdict).toMatchObject({
        authorized: false,
        refusal: 'undetermined'
      })
    })

    it('refuses when the repo is unstated', () => {
      const verdict = evaluateAuthorization(input({ repo: '' }))

      expect(verdict).toMatchObject({
        authorized: false,
        refusal: 'undetermined'
      })
    })

    it.each(['alice/../bob', 'alice/bob', '../admin', 'ali ce'])(
      'refuses %s — a malformed login is uncertainty, not a permission',
      (actor) => {
        const verdict = evaluateAuthorization(input({ actor }))

        expect(verdict).toMatchObject({
          authorized: false,
          refusal: 'undetermined'
        })
      }
    )

    it.each(['acme', 'acme/widgets/extra', 'acme/../widgets', 'acme/..'])(
      'refuses %s — a malformed repository is uncertainty too',
      (repo) => {
        const verdict = evaluateAuthorization(input({ repo }))

        expect(verdict).toMatchObject({
          authorized: false,
          refusal: 'undetermined'
        })
      }
    )
  })
})

describe('isProbeableTarget', () => {
  // The rejections are covered through `evaluateAuthorization` above; what is
  // only assertable here is the accept, which is what tells the shell to spend
  // a subprocess.
  it('accepts a well-formed login and owner/repo', () => {
    expect(isProbeableTarget('galo-sandoval', 'acme/widgets.js')).toBe(true)
  })

  it('accepts an App login so the machine edge gets a probed answer', () => {
    // The loop's own edge triggers as a bot. Refusing the shape here made the
    // reason `"github-actions[bot]" is not a GitHub login`, which is false —
    // the collaborators endpoint answers for it.
    expect(isProbeableTarget('github-actions[bot]', 'acme/widgets')).toBe(true)
    expect(isProbeableTarget('claude-code[bot]', 'acme/widgets')).toBe(true)
  })

  it('still rejects a bracket shape that is not the [bot] suffix', () => {
    expect(isProbeableTarget('alice[bot]x', 'acme/widgets')).toBe(false)
    expect(isProbeableTarget('alice/../octocat[bot]', 'acme/widgets')).toBe(
      false
    )
  })
})
