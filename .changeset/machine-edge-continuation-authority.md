---
'@galosandoval/shopfloor': minor
---

Gate and authorize the machine edge on three facts, and replace the admitted
verdict's `permission` field with `authorizedBy` (shopfloor#46).

0.17.0 admitted a `workflow_run.completed` failure on any `agent/issue-<n>`
branch and then probed the triggering actor's collaborator permission. Both
halves were wrong: the branch prefix alone is a name a stranger can pick, and
`workflow_run.triggering_actor` is frequently `github-actions[bot]`, whose
permission is `none` — so the probe refused the loop's own retrigger every time.

**The machine edge now requires three facts, not one.** The `agent/issue-<n>`
prefix is a pre-filter. The failure must also come from **your** repository
(`head_repository.full_name` equal to `repository.full_name` — a fork PR carries
the fork's ref with your repository in `repository`) and from a commit authored
by `claude-code[bot]`. An unstated head repository refuses like a mismatched one.

Those fences then **replace** the permission probe on that edge. What authorizes
a continuation is that pushing to `agent/issue-<n>` on your repository already
requires write access; the fork fence is what keeps that true, which is why it
is not optional.

**Breaking for anyone reading the admitted verdict.** The top-level `permission`
field is gone, replaced by `authorizedBy`: `{ via: 'permission', permission }`
on the human edge, `{ via: 'continuation' }` on the machine edge.

**New:** `AGENT_COMMIT_AUTHOR` — the commit identity the machine edge attributes
to the agent, `claude-code[bot]`. Fixed, not configurable, for the reason the
label vocabulary is fixed: a consumer naming their own identity here would turn
every push they make onto an agent branch into a retrigger.

**Two consequences worth checking before you wire this up.** Your agent's
commits must be authored as `claude-code[bot]` or the machine edge never fires;
and a maintainer pushing a fix onto the agent's own branch now correctly does
**not** retrigger the loop.
