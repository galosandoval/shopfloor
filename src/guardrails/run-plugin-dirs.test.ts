/**
 * The plugin-directory shell, against real fixture plugins on disk rather than
 * a mocked `fs` — what is under test here is precisely whether the probes read
 * the layout the CLI actually reads, which a stubbed filesystem could only
 * restate. The verdict logic itself is tested pure in `plugin-dirs.test.ts`.
 */

import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { runPluginDirsCheck } from './run-plugin-dirs'

let root: string

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'shopfloor-plugins-'))
})

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true })
})

/** Contents of a manifest declaring one nested skill, as the real plugin does. */
const DECLARES_NESTED_SKILL = {
  name: 'skills',
  skills: ['./skills/engineering/tdd']
}

/**
 * Write a plugin into `root/<name>`: its manifest (unless `manifest` is
 * omitted), and every file or directory in `files` — a trailing `/` makes a
 * directory.
 */
function writePlugin(
  name: string,
  { manifest, files = [] }: { manifest?: unknown; files?: string[] }
): string {
  const dir = path.join(root, name)
  if (manifest !== undefined) {
    fs.mkdirSync(path.join(dir, '.claude-plugin'), { recursive: true })
    fs.writeFileSync(
      path.join(dir, '.claude-plugin', 'plugin.json'),
      typeof manifest === 'string' ? manifest : JSON.stringify(manifest)
    )
  }
  fs.mkdirSync(dir, { recursive: true })
  for (const file of files) {
    const target = path.join(dir, file)
    if (file.endsWith('/')) {
      fs.mkdirSync(target, { recursive: true })
    } else {
      fs.mkdirSync(path.dirname(target), { recursive: true })
      fs.writeFileSync(target, '')
    }
  }
  return dir
}

describe('runPluginDirsCheck', () => {
  it('accepts a plugin whose manifest declares nested skills that exist', () => {
    writePlugin('skills', {
      manifest: DECLARES_NESTED_SKILL,
      files: ['skills/engineering/tdd/SKILL.md']
    })

    expect(runPluginDirsCheck(['skills'], root)).toEqual({ refused: false })
  })

  it('accepts the flat convention: no declared skills, a skills directory present', () => {
    writePlugin('flat', {
      manifest: { name: 'flat' },
      files: ['skills/design/SKILL.md']
    })

    expect(runPluginDirsCheck(['flat'], root)).toEqual({ refused: false })
  })

  it('resolves a relative entry against the run’s cwd, not this process’s', () => {
    writePlugin('nested/deep', {
      manifest: { name: 'deep' },
      files: ['skills/x/SKILL.md']
    })

    expect(runPluginDirsCheck(['nested/deep'], root)).toEqual({
      refused: false
    })
  })

  it('accepts an absolute entry', () => {
    const dir = writePlugin('abs', {
      manifest: { name: 'abs' },
      files: ['skills/x/SKILL.md']
    })

    expect(runPluginDirsCheck([dir], '/nowhere')).toEqual({ refused: false })
  })

  it('accepts an archive on existence alone, whatever it contains', () => {
    fs.writeFileSync(path.join(root, 'plugin.zip'), 'not really a zip')

    expect(runPluginDirsCheck(['plugin.zip'], root)).toEqual({ refused: false })
  })

  it('refuses a file that is not an archive', () => {
    fs.writeFileSync(path.join(root, 'notes.txt'), 'not a plugin at all')

    expect(refusalFor(['notes.txt'])).toMatch(/only a \.zip archive/i)
  })

  it('refuses a manifest that exists but cannot be read, saying so', () => {
    const dir = path.join(root, 'unreadable')
    // A directory where the manifest belongs: present to a caller, unreadable
    // to `readFileSync`, and emphatically not "no manifest at all".
    fs.mkdirSync(path.join(dir, '.claude-plugin', 'plugin.json'), {
      recursive: true
    })

    expect(refusalFor(['unreadable'])).toMatch(/could not be read/i)
  })

  it('accepts nothing to check', () => {
    expect(runPluginDirsCheck([], root)).toEqual({ refused: false })
  })

  it('refuses an entry that is not on disk', () => {
    expect(refusalFor(['gone'])).toMatch(/does not resolve/i)
  })

  it('refuses a directory with no manifest', () => {
    writePlugin('bare', { files: ['skills/x/SKILL.md'] })

    expect(refusalFor(['bare'])).toMatch(/not a plugin/i)
  })

  it('refuses a manifest that is not JSON', () => {
    writePlugin('broken', { manifest: '{ not json' })

    expect(refusalFor(['broken'])).toMatch(/not a readable JSON object/i)
  })

  it('refuses a manifest that parses to something other than an object', () => {
    writePlugin('array', { manifest: '["skills"]' })

    expect(refusalFor(['array'])).toMatch(/not a readable JSON object/i)
  })

  it('refuses a declared skill path that is absent, naming it', () => {
    writePlugin('rotted', {
      manifest: { name: 'rotted', skills: ['./skills/a', './skills/b'] },
      files: ['skills/a/SKILL.md']
    })

    expect(refusalFor(['rotted'])).toContain('./skills/b')
  })

  it('refuses a plugin declaring no skills and carrying no skills directory', () => {
    writePlugin('empty', { manifest: { name: 'empty' }, files: ['README.md'] })

    expect(refusalFor(['empty'])).toMatch(/no skills/i)
  })

  it('refuses hooks declared in the manifest', () => {
    writePlugin('hooked', {
      manifest: { name: 'hooked', hooks: './hooks/hooks.json' },
      files: ['skills/x/SKILL.md']
    })

    expect(refusalFor(['hooked'])).toContain('manifest hooks')
  })

  it('refuses MCP servers declared in the manifest', () => {
    writePlugin('mcp', {
      manifest: { name: 'mcp', mcpServers: { thing: { command: 'node' } } },
      files: ['skills/x/SKILL.md']
    })

    expect(refusalFor(['mcp'])).toContain('manifest mcpServers')
  })

  it('refuses a hooks directory the manifest never mentions', () => {
    writePlugin('conventional-hooks', {
      manifest: { name: 'conventional-hooks' },
      files: ['skills/x/SKILL.md', 'hooks/hooks.json']
    })

    expect(refusalFor(['conventional-hooks'])).toContain('hooks/ directory')
  })

  it('refuses an .mcp.json the manifest never mentions', () => {
    writePlugin('conventional-mcp', {
      manifest: { name: 'conventional-mcp' },
      files: ['skills/x/SKILL.md', '.mcp.json']
    })

    expect(refusalFor(['conventional-mcp'])).toContain('.mcp.json')
  })

  it('permits prose-only content — commands and agents are not capabilities', () => {
    writePlugin('prose', {
      manifest: { name: 'prose', commands: './commands', agents: './agents' },
      files: ['skills/x/SKILL.md', 'commands/go.md', 'agents/helper.md']
    })

    expect(runPluginDirsCheck(['prose'], root)).toEqual({ refused: false })
  })

  it('names every offending entry in one refusal', () => {
    writePlugin('ok', { manifest: { name: 'ok' }, files: ['skills/x/S.md'] })

    const reason = refusalFor(['gone-one', 'ok', 'gone-two'])

    expect(reason).toContain('gone-one')
    expect(reason).toContain('gone-two')
    expect(reason).not.toMatch(/^- ok:/m)
  })
})

/** The refusal reason for `entries`, failing the test if they were accepted. */
function refusalFor(entries: string[]): string {
  const verdict = runPluginDirsCheck(entries, root)
  if (!verdict.refused) throw new Error('expected a refusal')
  return verdict.reason
}
