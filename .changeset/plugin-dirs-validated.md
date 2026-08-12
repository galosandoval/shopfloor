---
'@galosandoval/shopfloor': minor
---

Add `pluginDirs` (`PLUGIN_DIRS`, comma-separated): Claude Code plugin
directories loaded into a run for that session only, one `--plugin-dir` per
entry, so a plugin's skills reach the agent through the CLI's own discovery
with nothing written into your git tree.

**New failure mode — a run now refuses before spawning** when a stated entry
does not resolve, is not a plugin (no readable `.claude-plugin/plugin.json`),
declares no skills while carrying no `skills/` directory, declares a skill path
that is absent on disk, or ships **hooks or MCP servers** (from the manifest or
from the `hooks/` and `.mcp.json` conventions). The refusal names every
offending entry. Nothing else changes for a caller who states no plugins:
unstated is held apart from stated-as-empty, and neither puts a flag on the
CLI vector.

The capability refusal is the point, not a side effect: these runs already pass
`--dangerously-skip-permissions`, so a plugin's permission declarations are
moot, while hooks execute without the model choosing them and MCP-contributed
tools fall outside the command guard, which matches shell commands only. Barring
both is what makes the promise checkable — **a stated plugin adds no automatic
code execution and no tools outside the command guard.** Prose-only plugin
content (skills, subagents, slash commands) is permitted.

An entry that is a `.zip` archive is checked **for existence only** — including
the capability check, which does not apply to it. That is a deliberately weaker
guarantee: inspecting it would mean unpacking it. A `.zip` is the only file
form accepted; any other file is refused, since nothing about it can be
checked.

`standardsDir` is removed in this same release; see its own entry.
