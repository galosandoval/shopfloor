# CLAUDE.md

When reporting information to me, be extremely concise and sacrifice grammar for the sake of concision.

`@galosandoval/shopfloor` — a typed, tested harness that spawns the Claude Code
CLI headlessly to implement a labeled GitHub issue as a draft PR. Library +
thin bin, no framework. Node 20+, ESM, TypeScript, vitest, tsup. Scripts are in
`package.json`; CI (`.github/workflows/release.yml`) runs lint, typecheck, test,
and build.

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
rules. Tests follow from it: assert inputs and outputs of the pure functions
with no IO mocking, and **test the wiring separately** — a unit test on a pure
function proves nothing about whether a run calls it.

## Coding standards

They live in this repository — the two docs linked above; why there, and where
they came from, is
[`CONTEXT.md`](./CONTEXT.md#standards-in-repo-procedures-in-skills). The same
line decides what this package ships: **procedure ships, standards do not** —
skills arrive with an install as the bundled plugin, opinionated standards
never do. One thing neither doc says: the public surface is `src/index.ts`,
nothing else.

## What this package deliberately does not own

Each was decided against; don't add them.

- **Prompt content** beyond the harness's invocation defaults — per-consumer.
  **Amended again by #47:** prompts are keyed by phase, and a per-phase default
  ships — a thin invocation shim that names the phase, says where the run's
  outputs go, and defers to the bundled skills plugin for procedure. Read the
  boundary it keeps: the shim carries no procedure (that is skills, and two
  copies would have no rule for which wins) and no environment (that is the
  consumer's, filled by `init` from their own project). A discovered phase with
  no prompt refuses at startup naming the phase.
  The doctor's environment fences are the boundary case, and they stay on this
  side of it: a fence and a `TODO(shopfloor)` sentinel are prompt _format_, the
  minimum that makes "unfilled" machine-checkable rather than a judgement about
  prose. What goes between them is still never shipped. The one thing the
  harness appends for itself is an iterating run's gate failure (shopfloor#40) —
  the command it ran, the output it got, and that the run is not done until that
  command passes. Facts and contract; how to fix a failing suite is procedure,
  and stays out. **Amended by #43** (design §11): `init` scaffolds a per-phase
  prompt _skeleton_ — a shim to the skills plugin carrying the six substituted
  tokens — and fills its environment block from the consumer's own lockfile and
  scripts. Read what that does and does not widen: the content is still the
  consumer's, read off their project rather than shipped; what ships is the
  shape, and a value that cannot be read is the sentinel rather than a default.
- **Opinionated coding standards for consumers** — theirs live in the
  repository being worked on; `standardsDir` was removed rather than repointed
  (#27). This repository's own standards are not shipped. Procedure is the
  narrow exception, and only as a default: the bundled skills plugin arrives
  with an install, and a stated `pluginDirs` replaces it outright.
- **Consumer env-var names** — `requiredEnvVars` is caller-stated, and so are
  the doctor's `requiredSecrets` (with a default naming the two the loop cannot
  run without). **Broken as a class by #45** (design §11's amendment table):
  the six label names are package-owned, `ready-for-agent` and
  `ready-for-human` included — two names describing the _consumer's_ process,
  not the harness's. Fixed names can be guaranteed; configurable ones can only
  be validated against bindings the package does not own (shopfloor#39,
  design §8). Read the break for exactly what it is: a vocabulary the package
  now owns, verifies, and refuses on, and a state machine written over it —
  not licence to start naming a consumer's env vars or scripts. Everything
  else in this bullet still holds.
- **CI glue** — callers own `$GITHUB_OUTPUT`, exit codes, branch checkout, the
  PR. **Amended by #43**: `init` scaffolds a workflow template wired to the two
  admitted trigger events. It is a starting point a consumer then owns, written
  once when asked; nothing here reads it back or keeps it in sync. **Amended
  again by #47, and this one is a transfer rather than an addition**: the
  harness now owns **branch creation, pull-request creation, and issue state**,
  because a retrigger must locate both to iterate at all and something located
  on every loop edge is already owned — leaving creation outside meant two
  components computing the same branch identity, which is exactly what the
  consumer's `tr`/`sed`/`cut` slug pipeline was. What a caller keeps is the
  checkout, the exit code, and the setup-free admission job in front of
  `runPhase`. The public surface is one verb; `runImplementAgent`,
  `runPreflight`, `postVerifyComment`, and `runPluginDirsCheck` are internals
  it composes, and the sequencing between them — the thing that was actually
  the interface — is now typed and tested rather than written in bash.
- **Evals** — a named, open gap, not an oversight to close casually.

Two capability classes were added rather than removed, and both are worth
stating because neither existed before #43.

**The package configures the consumer's repository** — creating labels,
scaffolding files. Only when a human runs `init`, never as a side effect of a
run, and never over a file whose contents it cannot account for.

**The package writes to the consumer's repository during a run** (#47) — it
creates the branch, pushes it, opens the draft PR, and moves the issue's
labels. Bounded three ways, and the bounds are the decision: it writes only on
the branch it owns by name, only to the issue the payload named, and only after
admission and preflight admitted the run. **Refusals still write nothing** —
except preflight's, whose refusal _is_ a judgement about the issue. Setup is
still verify-and-refuse: a run creates no labels, ever.

Multi-step procedures belong in skills, not in this file.
