/**
 * The plugin-directory refusal, asserted as a table of gathered facts and
 * verdicts — no filesystem, no mocking. That the shell gathers these facts
 * correctly, and that a run consults the verdict at all, are separate tests
 * (`run-plugin-dirs.test.ts`, `implement.test.ts`).
 */

import { evaluatePluginDirs, type PluginDirFacts } from './plugin-dirs'

/** A plugin that passes every check: a manifest declaring skills that exist. */
function validPlugin(overrides: Partial<PluginDirFacts> = {}): PluginDirFacts {
  return {
    entry: '/plugins/skills',
    resolves: 'directory',
    manifest: 'present',
    declaredSkills: ['./skills/engineering/tdd'],
    absentSkills: [],
    hasSkillsDir: true,
    capabilities: [],
    ...overrides
  }
}

describe('evaluatePluginDirs', () => {
  describe('acceptance', () => {
    it('accepts a plugin whose manifest declares skills that are all on disk', () => {
      expect(evaluatePluginDirs([validPlugin()])).toEqual({ refused: false })
    })

    it('accepts a manifest declaring no skills when a skills directory is present', () => {
      const verdict = evaluatePluginDirs([
        validPlugin({ declaredSkills: [], hasSkillsDir: true })
      ])

      expect(verdict).toEqual({ refused: false })
    })

    it('accepts a .zip archive on existence alone', () => {
      const verdict = evaluatePluginDirs([
        {
          entry: '/plugins/skills.zip',
          resolves: 'file',
          manifest: 'absent',
          declaredSkills: [],
          absentSkills: [],
          hasSkillsDir: false,
          capabilities: []
        }
      ])

      expect(verdict).toEqual({ refused: false })
    })

    it('accepts an empty list — nothing stated, nothing to check', () => {
      expect(evaluatePluginDirs([])).toEqual({ refused: false })
    })
  })

  describe('refusal', () => {
    it('refuses an entry that does not resolve, naming it', () => {
      const verdict = evaluatePluginDirs([
        validPlugin({ entry: '/gone', resolves: 'absent' })
      ])

      expect(verdict.refused).toBe(true)
      expect(refusalReason(verdict)).toContain('/gone')
      expect(refusalReason(verdict)).toMatch(/does not resolve/i)
    })

    it('refuses a directory that is not a plugin', () => {
      const verdict = evaluatePluginDirs([validPlugin({ manifest: 'absent' })])

      expect(refusalReason(verdict)).toMatch(/not a plugin/i)
    })

    it('refuses a file that is not a .zip archive, which nothing can check', () => {
      const verdict = evaluatePluginDirs([
        validPlugin({ entry: '/plugins/notes.txt', resolves: 'file' })
      ])

      expect(refusalReason(verdict)).toMatch(/only a \.zip archive/i)
    })

    it('reports an unreadable manifest as itself, not as “not a plugin”', () => {
      const verdict = evaluatePluginDirs([
        validPlugin({ manifest: 'unreadable' })
      ])

      expect(refusalReason(verdict)).toMatch(/could not be read/i)
      expect(refusalReason(verdict)).not.toMatch(/not a plugin/i)
    })

    it('refuses a plugin whose manifest cannot be parsed', () => {
      const verdict = evaluatePluginDirs([
        validPlugin({ manifest: 'unparseable' })
      ])

      expect(refusalReason(verdict)).toMatch(/manifest/i)
    })

    it('refuses a manifest declaring no skills when no skills directory exists', () => {
      const verdict = evaluatePluginDirs([
        validPlugin({ declaredSkills: [], hasSkillsDir: false })
      ])

      expect(refusalReason(verdict)).toMatch(/no skills/i)
    })

    it('refuses a declared skill path that is absent, naming the path', () => {
      const verdict = evaluatePluginDirs([
        validPlugin({
          declaredSkills: ['./skills/a', './skills/b'],
          absentSkills: ['./skills/b']
        })
      ])

      expect(refusalReason(verdict)).toContain('./skills/b')
      expect(refusalReason(verdict)).not.toContain('./skills/a')
    })

    it('names every offending entry, not just the first', () => {
      const verdict = evaluatePluginDirs([
        validPlugin({ entry: '/one', resolves: 'absent' }),
        validPlugin({ entry: '/two' }),
        validPlugin({ entry: '/three', manifest: 'absent' })
      ])

      expect(refusalReason(verdict)).toContain('/one')
      expect(refusalReason(verdict)).toContain('/three')
      expect(refusalReason(verdict)).not.toContain('/two')
    })
  })

  describe('capability refusal', () => {
    it.each([
      ['manifest hooks'],
      ['manifest mcpServers'],
      ['hooks/ directory'],
      ['.mcp.json']
    ] as const)('refuses a plugin carrying %s', (capability) => {
      const verdict = evaluatePluginDirs([
        validPlugin({ capabilities: [capability] })
      ])

      expect(refusalReason(verdict)).toContain(capability)
    })

    it('names every capability the plugin carries', () => {
      const verdict = evaluatePluginDirs([
        validPlugin({ capabilities: ['manifest hooks', '.mcp.json'] })
      ])

      expect(refusalReason(verdict)).toContain('manifest hooks')
      expect(refusalReason(verdict)).toContain('.mcp.json')
    })

    it('reports the capability rather than a skills problem when both hold', () => {
      const verdict = evaluatePluginDirs([
        validPlugin({
          capabilities: ['hooks/ directory'],
          hasSkillsDir: false,
          declaredSkills: []
        })
      ])

      expect(refusalReason(verdict)).toContain('hooks/ directory')
      expect(refusalReason(verdict)).not.toMatch(/no skills/i)
    })

    it('ignores capabilities on an archive, which is checked for existence only', () => {
      const verdict = evaluatePluginDirs([
        validPlugin({
          entry: '/plugins/skills.zip',
          resolves: 'file',
          capabilities: ['.mcp.json']
        })
      ])

      expect(verdict).toEqual({ refused: false })
    })
  })
})

/** The reason off a verdict the test has already asserted is a refusal. */
function refusalReason(verdict: ReturnType<typeof evaluatePluginDirs>): string {
  if (!verdict.refused) throw new Error('expected a refusal')
  return verdict.reason
}
