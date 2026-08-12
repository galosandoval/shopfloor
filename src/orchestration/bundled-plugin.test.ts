/**
 * The bundled plugin is a real dependency on a real disk, so this suite uses
 * both. What that proves is the thing a mocked filesystem could not: that the
 * package pinned in `package.json` is actually installed beside this one, and
 * that it passes the same {@link runPluginDirsCheck} a stated entry does. A
 * green suite here means a consumer's `npm install` brings a plugin this
 * harness will accept.
 *
 * The one exception is the refusal, which needs the dependency *absent* — an
 * install this repository cannot have and still run its own tests. Module
 * resolution is stubbed for that case alone: the process boundary, not the
 * logic, and the only way to reach a branch the changeset advertises as a new
 * failure mode.
 */

import * as fs from 'node:fs'
import { createRequire } from 'node:module'
import * as path from 'node:path'
import {
  BUNDLED_PLUGIN_PACKAGE,
  resolveBundledPluginDir
} from './bundled-plugin'
import { runPluginDirsCheck } from '../guardrails/run-plugin-dirs'
import { PLUGIN_MANIFEST_PATH } from '../guardrails/plugin-dirs'

vi.mock('node:module', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:module')>()
  // Real by default — every test below the refusal resolves the dependency
  // that is genuinely installed.
  return { ...actual, createRequire: vi.fn(actual.createRequire) }
})

describe('resolveBundledPluginDir', () => {
  it('resolves to the installed skills package', () => {
    const dir = resolveBundledPluginDir()

    expect(fs.statSync(dir).isDirectory()).toBe(true)
    expect(path.basename(dir)).toBe(BUNDLED_PLUGIN_PACKAGE)
  })

  it('resolves to a directory carrying a plugin manifest', () => {
    const manifest = path.join(resolveBundledPluginDir(), PLUGIN_MANIFEST_PATH)

    expect(fs.existsSync(manifest)).toBe(true)
  })

  it('resolves to a plugin the pre-spawn check accepts', () => {
    const verdict = runPluginDirsCheck(
      [resolveBundledPluginDir()],
      process.cwd()
    )

    expect(verdict).toEqual({ refused: false })
  })

  it('refuses when the dependency is not installed, naming the package', () => {
    // A pruned `node_modules`, or an install that skipped dependencies.
    vi.mocked(createRequire).mockReturnValueOnce({
      resolve: () => {
        throw new Error('Cannot find module')
      }
    } as unknown as NodeJS.Require)

    expect(() => resolveBundledPluginDir()).toThrow(
      new RegExp(`${BUNDLED_PLUGIN_PACKAGE}[\\s\\S]*Reinstall`)
    )
  })
})
