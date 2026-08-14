/**
 * Pure validation of the Claude Code plugin directories a caller states
 * (shopfloor#25). Each entry reaches the CLI as `--plugin-dir`, so its skills
 * load into the session without anything being written into the consumer's git
 * tree — the agent commits its own work, and files it did not create risk
 * being swept into a commit. Nothing spawns until every entry passes.
 *
 * No IO here — {@link runPluginDirsCheck} probes the filesystem and hands the
 * facts over; {@link runImplementAgent} acts on the verdict.
 *
 * **The check asserts what a manifest asserts about itself, and no more.** No
 * counting of skill files, no frontmatter parsing: anything deeper is a
 * second, independent model of how the CLI discovers skills, and it would
 * drift from the real one. The original framing of this work already got that
 * wrong, assuming a flat skill layout that the plugin actually in use does not
 * have.
 */

/** The one archive form the CLI loads a plugin from. */
export const PLUGIN_ARCHIVE_EXTENSION = '.zip'

/** Where a plugin's manifest lives, relative to the plugin directory. */
export const PLUGIN_MANIFEST_PATH = '.claude-plugin/plugin.json'

/**
 * Convention paths the CLI reads by name alone. Published plugins commonly
 * declare none of these in their manifest and rely on the directory layout, so
 * a check that only read the manifest would miss the capabilities outright.
 */
export const PLUGIN_SKILLS_DIR = 'skills'
export const PLUGIN_HOOKS_DIR = 'hooks'
export const PLUGIN_MCP_CONFIG = '.mcp.json'

/**
 * A capability that refuses a plugin, labelled as the message names it —
 * manifest keys and convention paths alike.
 *
 * Only these two surfaces. These runs already pass
 * `--dangerously-skip-permissions`, so a plugin's tool-permission
 * declarations are moot; nothing is gated either way. What is *not* moot is
 * code that runs automatically without the model choosing to invoke it
 * (hooks), and tools that fall outside the command guard — which matches shell
 * commands only, and therefore cannot see a tool contributed by an MCP server.
 * Prose the model may or may not read is not a capability grant here, so
 * skills, subagent definitions, and slash commands are deliberately permitted;
 * a headless run never even invokes a slash command.
 */
export type PluginCapability =
  'manifest hooks' | 'manifest mcpServers' | 'hooks/ directory' | '.mcp.json'

/** What the shell probed about one stated entry. */
export interface PluginDirFacts {
  /** The entry exactly as stated — every message names it. */
  entry: string
  /**
   * What the path is on disk, raw — whether a file counts as a plugin archive
   * is decided here rather than by the shell, from the extension the CLI
   * itself accepts.
   */
  resolves: 'absent' | 'file' | 'directory'
  /**
   * The manifest at {@link PLUGIN_MANIFEST_PATH}. `'unreadable'` is held apart
   * from `'absent'` so a permission error is never reported as "not a plugin"
   * — misdiagnosing the cause is the exact silence this refusal exists to end.
   */
  manifest: 'absent' | 'unreadable' | 'unparseable' | 'present'
  /** Skill paths the manifest declares, verbatim; empty when it declares none. */
  declaredSkills: string[]
  /** The subset of {@link PluginDirFacts.declaredSkills} with nothing on disk. */
  absentSkills: string[]
  /** Whether {@link PLUGIN_SKILLS_DIR} is present. */
  hasSkillsDir: boolean
  /** Every capability surface found; any one of them refuses. */
  capabilities: PluginCapability[]
}

export type PluginDirsVerdict =
  { refused: false } | { refused: true; reason: string }

/**
 * Decide whether every stated plugin directory is safe to load. Refuses with
 * one line per offending entry rather than only the first: a misconfigured run
 * costs a round trip to fix, and naming one of three bad paths makes that
 * three round trips.
 */
export function evaluatePluginDirs(facts: PluginDirFacts[]): PluginDirsVerdict {
  const problems = facts
    .map((entry) => {
      const problem = findProblem(entry)
      return problem && `- ${entry.entry}: ${problem}`
    })
    .filter((line): line is string => Boolean(line))

  if (problems.length === 0) return { refused: false }

  return {
    refused: true,
    reason:
      'Refusing to run — stated plugin director' +
      (problems.length === 1 ? 'y' : 'ies') +
      ` failed validation:\n${problems.join('\n')}\n` +
      'Point `pluginDirs` / PLUGIN_DIRS at plugin directories that resolve, ' +
      'carry skills, and ship neither hooks nor MCP servers.'
  }
}

/**
 * What is wrong with one entry, or undefined when nothing is. Ordered by which
 * failure a reader most needs to hear first: an entry that isn't a plugin has
 * no manifest to say anything else about, and a capability is a refusal on
 * safety grounds that a missing skills directory should not mask.
 */
function findProblem(facts: PluginDirFacts): string | undefined {
  if (facts.resolves === 'absent') {
    return `does not resolve to a directory or a ${PLUGIN_ARCHIVE_EXTENSION} archive`
  }
  if (facts.resolves === 'file') {
    // An archive stops here on purpose — the weaker guarantee, documented as
    // one. Any other file does not: it is checkable only by unpacking, which
    // it cannot be, so it would otherwise reach the CLI wholly unvalidated.
    return facts.entry.endsWith(PLUGIN_ARCHIVE_EXTENSION)
      ? undefined
      : `is a file, and only a ${PLUGIN_ARCHIVE_EXTENSION} archive may be loaded as one`
  }

  if (facts.manifest === 'absent') {
    return `not a plugin — no ${PLUGIN_MANIFEST_PATH}`
  }
  if (facts.manifest === 'unreadable') {
    return `plugin manifest ${PLUGIN_MANIFEST_PATH} exists but could not be read`
  }
  if (facts.manifest === 'unparseable') {
    return `plugin manifest ${PLUGIN_MANIFEST_PATH} is not a readable JSON object`
  }

  if (facts.capabilities.length > 0) {
    return (
      `ships ${facts.capabilities.join(', ')} — this package promises a run ` +
      'adds no automatic code execution and no tools outside the command guard'
    )
  }

  if (facts.declaredSkills.length === 0) {
    return facts.hasSkillsDir
      ? undefined
      : `declares no skills and has no ${PLUGIN_SKILLS_DIR}/ directory`
  }

  if (facts.absentSkills.length > 0) {
    return `declares skill path(s) that are absent: ${facts.absentSkills.join(', ')}`
  }

  return undefined
}
