# CLAUDE.md

When reporting information to me, be extremely concise and sacrifice grammar for
the sake of concision.

`@galosandoval/shopfloor` — a typed, tested harness that spawns the Claude Code
CLI headlessly to implement a labeled GitHub issue as a draft PR.

**This file holds only what is not obvious from the code.** Rules as they stand
today; the reasoning is in [`CONTEXT.md`](./CONTEXT.md) and the history is in
`git log`. An amendment rewrites the rule it amends — it is never appended after
it, because a rule followed by its own retraction is wrong to anyone who stops
reading at the first sentence.

- [`CONTEXT.md`](./CONTEXT.md) — architecture, module map, run flow, invariants.
- [`docs/testing.md`](./docs/testing.md) — read before writing a test.
- [`docs/typescript-style.md`](./docs/typescript-style.md) — size, colocation, extraction.
- [`docs/doc-comments.md`](./docs/doc-comments.md) — when a comment becomes a doc block.
- [`README.md`](./README.md) — the consumer-facing API; keep it accurate.

## Every PR carries a changeset

`npx changeset` — CI fails a PR that has none. A PR that deliberately ships
nothing — docs, CI config, tests — records an explicit empty one,
`npx changeset --empty`, so "this doesn't release" is on the record rather than
inferred from silence. Pre-`1.0.0`: write the body for a consumer deciding
whether the bump is safe, naming new failure modes and what breaks, not just
what was added.

**One merge releases.** Before merging to `main`, run `npm run version:packages`
and commit what it writes — the version bump and the `CHANGELOG.md` entry ride
in the PR itself, and merging publishes. There is no "Version Packages" PR to
merge afterwards; CI on `main` only runs `changeset publish` and pushes the tag,
and never writes to `main`. Re-run it if you push more commits after versioning.
A PR that ships nothing skips this and just carries its empty changeset, which
the next versioning PR consumes.

## Pure core, IO shell

Every module that makes a decision splits in two: a **pure function** over
already-gathered facts (no `fs`, `child_process`, `process.env`, or clock — an
env arrives as a parameter), and a **thin shell** that probes, calls it, and
acts on the verdict. New decisions land in that shape;
[`CONTEXT.md`](./CONTEXT.md#pure-core-io-shell) has the naming and placement
rules.

The consequence people miss: assert the pure functions with no IO mocking, and
**test the wiring separately** — a unit test on a pure function proves nothing
about whether a run calls it.

## Standards and procedure

**Procedure ships, standards do not.** Skills arrive with an install as the
bundled plugin; opinionated standards never do, and a consumer's own live in the
repository being worked on. This repository's standards are the docs linked
above — why they live here rather than in a skill is
[`CONTEXT.md`](./CONTEXT.md#standards-in-repo-procedures-in-skills).

The public surface is `src/index.ts`, nothing else.

Multi-step procedures belong in skills, not in this file.

## What the package owns in a consumer's repository

The boundary is narrow on purpose and has moved three times; what follows is
where it is now.

**It configures the repository** — creating labels, scaffolding prompts and a
workflow template — only when a human runs `init`, never as a side effect of a
run, and never over a file whose contents it cannot account for.

**It writes to the repository during a run**: the branch, the draft PR, the
issue's labels, and its own handoff commits under `attemptsDir`. Five bounds,
all load-bearing — only on the branch it owns by name, only on the issue the
payload named, only after admission and preflight admitted the run, never
outside `attemptsDir`, and always path-limited so nothing else in the working
tree is swept into a bookkeeping commit.

**Refusals write nothing** — except preflight's, whose refusal _is_ a judgement
about the issue. A run creates no labels, ever.

## What it deliberately does not own

Each was decided against; don't add them.

- **Prompt content** beyond a per-phase shim that names the phase, says where
  the run's outputs go, and defers to the skills plugin for procedure. No
  procedure (that is skills, and two copies would have no rule for which wins)
  and no environment (that is the consumer's, filled by `init` from their own
  project). A discovered phase with no prompt refuses at startup, naming it.
  Two things the harness does write into a prompt, and the line between them and
  the rest is that both are facts rather than judgements: the doctor's
  environment fences and `TODO(shopfloor)` sentinel, which are prompt _format_
  and only make "unfilled" machine-checkable, and an iterating run's gate
  failure — the command, its output, and that the run is not done until it
  passes. How to fix a failing suite is procedure, and stays out.
- **Opinionated coding standards for consumers.** `standardsDir` was removed
  rather than repointed (#27).
- **Consumer env-var names and scripts** — `requiredEnvVars` and the doctor's
  `requiredSecrets` are caller-stated. The six label names are the one
  exception, and they are package-owned outright: fixed names can be guaranteed,
  configurable ones could only be validated against bindings this package does
  not own. That is a vocabulary the package owns, verifies, and refuses on — not
  licence to start naming anything else of the consumer's.
- **CI glue** — the caller keeps the checkout, the exit code, and the setup-free
  admission job in front of `runPhase`. `init` scaffolds a workflow template as a
  starting point the consumer then owns; nothing reads it back or keeps it in
  sync. The public surface is one verb: `runImplementAgent`, `runPreflight`,
  `postVerifyComment`, and `runPluginDirsCheck` are internals it composes, and
  the sequencing between them — the thing that was actually the interface — is
  now typed and tested rather than written in consumer bash.
- **The content of the agent's half of a handoff** — read back from a file the
  agent wrote, quoted verbatim, and marked as claims rather than restated as
  fact.
- **Evals** — a named, open gap, not an oversight to close casually.
