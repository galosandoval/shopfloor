---
'@galosandoval/shopfloor': minor
---

Remove `standardsDir`. Skills reach the agent through the Claude Code CLI's own
plugin discovery (`pluginDirs` / `PLUGIN_DIRS`, defaulting to the bundled
skills plugin), so a standards directory pasted into a prompt has nothing left
to do: it was instruction-by-path, with no progressive disclosure, no way to
load a reference only when a task called for it, and no way for the harness to
know whether the path meant anything.

**Breaking, in a minor — read this before bumping.**

**What breaks.** `standardsDir` is gone from `RunImplementAgentConfig`, so a
caller stating it no longer type-checks. The rendered prompt no longer
substitutes `{{STANDARDS_DIR}}`.

**What newly refuses.** A stated `standardsDir`, or a non-empty `STANDARDS_DIR`
in the environment, **refuses the run before spawning** with an
`ImplementAgentError` naming the replacement. This is deliberate and is the
migration mechanism: deleting the field quietly would leave a CI-set
`STANDARDS_DIR` meaning nothing at all — no type error, no runtime error, just
a run proceeding with less context than its operator believes it has, which is
the silent degradation `0.5.0`'s dead-path validation was added to stop. So a
run that was previously green and misconfigured now fails loudly instead. An
empty value from either source still means "deliberately skip" and does not
refuse. There is no deprecation window where both paths work.

**What to change.** Delete `standardsDir` from your call, unset `STANDARDS_DIR`
in your CI, and **remove `{{STANDARDS_DIR}}` from your prompt template** — an
unrecognized placeholder now renders as literal text, so a stale template
leaves `{{STANDARDS_DIR}}` sitting in the prompt the agent reads. The refusal
above means no run reaches a spawn with its configuration still wrong, but it
cannot see your template: a caller who fixes the config and leaves the template
stale is the one way this reaches an agent. Your coding standards belong in the
repository being worked on — its `CLAUDE.md` and the docs it points at — where
the agent reads them for itself.

**What this does not close.** Of the six kinds of context a harness owes an
agent, this moves **instructions** from delegated to shipped and **knowledge**
from absent to partial. **Memory**, **examples**, and **tools** stay at zero —
every run still starts cold, and a failed run still teaches the next one
nothing. **Evals** — scoring whether a run produced good work, and whether it
took a sound path to get there — remain the largest open gap. Native skills
wiring closed a rotting string, not context ownership.
