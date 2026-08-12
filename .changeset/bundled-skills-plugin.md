---
'@galosandoval/shopfloor': minor
---

Bundle the skills plugin: installing this package now brings the skills the
harness expects an agent to have, as a git dependency on
[`galosandoval/skills`](https://github.com/galosandoval/skills) pinned to the
tag `galosandoval-skills@1.1.0`. No second checkout to clone, no path to keep
`PLUGIN_DIRS` pointed at.

**Behavior change — an unstated `pluginDirs` no longer means "no plugins".** It
now resolves to the bundled plugin, so a run that previously spawned with no
`--plugin-dir` at all will spawn with one, and the agent's session carries
skills it did not have before. A stated list **replaces** the default rather
than adding to it; an explicitly empty list (`pluginDirs: []`, `PLUGIN_DIRS=''`)
restores the old behavior exactly — no plugins load.

**New failure mode — a missing bundled plugin refuses the run before spawning.**
The bundled plugin is validated by the same check a stated one is, with no
exemption, and the likeliest way it fails is not being on disk: a pruned
`node_modules`, an install that skipped dependencies, or an environment that
cannot fetch git dependencies at all. That refuses, naming
`galosandoval-skills` and telling you to reinstall or state your own
`pluginDirs` — rather than proceeding with none of the procedure the run was
configured to have. The lookup goes through Node's own module resolution from
this package's directory, so hoisted and nested layouts both answer; where it
cannot, state `pluginDirs` explicitly.

**New install requirement:** `git` and reachable GitHub at install time.

**New export — `resolveBundledPluginDir()`** (and `BUNDLED_PLUGIN_PACKAGE`),
because replacement means naming both is the only way to keep the bundled
plugin alongside your own:

```ts
import { resolveBundledPluginDir } from '@galosandoval/shopfloor'

pluginDirs: [resolveBundledPluginDir(), '/opt/my-plugin']
```

It throws `ImplementAgentError` when the dependency cannot be resolved, so CI
glue can surface that failure without starting a run.

The scope boundary narrows rather than reverses: **procedure ships, standards
do not.** Skills are portable across repositories and now arrive with the
install; opinionated coding standards remain per-repository, in the repository
being worked on — `standardsDir` is removed in this same release, see its own
entry.
