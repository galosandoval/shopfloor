/**
 * IO shell for the plugin-directory refusal (shopfloor#25): probes each stated
 * entry's layout on disk and hands the facts to {@link evaluatePluginDirs}.
 * Every filesystem read for that decision lives here and nowhere else;
 * {@link runImplementAgent} acts on the returned verdict.
 */

import * as fs from 'node:fs'
import * as path from 'node:path'
import {
  evaluatePluginDirs,
  PLUGIN_HOOKS_DIR,
  PLUGIN_MANIFEST_PATH,
  PLUGIN_MCP_CONFIG,
  PLUGIN_SKILLS_DIR,
  type PluginCapability,
  type PluginDirFacts,
  type PluginDirsVerdict
} from './plugin-dirs'

/**
 * Gather and judge every stated entry. `cwd` is the run's, not this process's:
 * a relative entry is resolved against the directory the CLI is spawned in,
 * which is where the CLI itself resolves `--plugin-dir` from.
 */
export function runPluginDirsCheck(
  entries: string[],
  cwd: string
): PluginDirsVerdict {
  return evaluatePluginDirs(entries.map((entry) => gatherFacts(entry, cwd)))
}

function gatherFacts(entry: string, cwd: string): PluginDirFacts {
  const dir = path.resolve(cwd, entry)
  const absent: PluginDirFacts = {
    entry,
    resolves: 'absent',
    manifest: 'absent',
    declaredSkills: [],
    absentSkills: [],
    hasSkillsDir: false,
    capabilities: []
  }

  // A file has no layout to probe — whether it is a loadable archive is the
  // pure function's call, from the entry's own extension.
  const kind = pathKind(dir)
  if (kind !== 'directory') return { ...absent, resolves: kind }

  const manifest = readManifest(path.join(dir, PLUGIN_MANIFEST_PATH))
  const declaredSkills = declaredSkillPaths(manifest)

  return {
    entry,
    resolves: 'directory',
    manifest: typeof manifest === 'string' ? manifest : 'present',
    declaredSkills,
    absentSkills: declaredSkills.filter(
      (skill) => pathKind(path.resolve(dir, skill)) === 'absent'
    ),
    hasSkillsDir: pathKind(path.join(dir, PLUGIN_SKILLS_DIR)) === 'directory',
    capabilities: findCapabilities(manifest, dir)
  }
}

/** A parsed manifest object, or why it isn't one. */
type Manifest =
  Record<string, unknown> | 'absent' | 'unreadable' | 'unparseable'

function readManifest(manifestPath: string): Manifest {
  if (pathKind(manifestPath) === 'absent') return 'absent'

  let raw: string
  try {
    raw = fs.readFileSync(manifestPath, 'utf8')
  } catch {
    // Present but unreadable — a permissions or directory problem, reported as
    // itself rather than as the "not a plugin" it is not.
    return 'unreadable'
  }

  try {
    const parsed: unknown = JSON.parse(raw)
    // A JSON array or scalar parses fine and still declares nothing this can
    // read, so it is no more a manifest than a syntax error is.
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return 'unparseable'
    }
    return parsed as Record<string, unknown>
  } catch {
    return 'unparseable'
  }
}

/** The manifest's declared skill paths — anything that isn't a list of strings declares none. */
function declaredSkillPaths(manifest: Manifest): string[] {
  if (typeof manifest === 'string') return []
  const skills = manifest.skills
  if (!Array.isArray(skills)) return []
  return skills.filter((skill): skill is string => typeof skill === 'string')
}

/**
 * Every capability surface the plugin carries, from the manifest and from the
 * convention paths alike — published plugins commonly declare neither key and
 * rely on directory names, so reading only the manifest would miss them.
 */
function findCapabilities(manifest: Manifest, dir: string): PluginCapability[] {
  const found: PluginCapability[] = []
  if (typeof manifest !== 'string') {
    if (manifest.hooks !== undefined) found.push('manifest hooks')
    if (manifest.mcpServers !== undefined) found.push('manifest mcpServers')
  }
  if (pathKind(path.join(dir, PLUGIN_HOOKS_DIR)) !== 'absent') {
    found.push('hooks/ directory')
  }
  if (pathKind(path.join(dir, PLUGIN_MCP_CONFIG)) !== 'absent') {
    found.push('.mcp.json')
  }
  return found
}

/** What a path is, with unreadable and missing collapsed into `'absent'`. */
function pathKind(target: string): 'absent' | 'file' | 'directory' {
  try {
    return fs.statSync(target).isDirectory() ? 'directory' : 'file'
  } catch {
    return 'absent'
  }
}
