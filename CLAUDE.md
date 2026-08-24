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
inferred from silence. Write the body for a consumer deciding whether the bump
is safe, naming new failure modes and what breaks, not just what was added.

Since `1.0.0`, semver means what it says: a breaking change is a major, and
"minor is additive" is a promise rather than the caveat it was pre-`1.0.0`.
Consumers still exact-pin, and that is their call, not a licence to break a
minor.

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
about the issue, and a spent attempt ceiling's, which is the loop's terminal
state. A run creates no labels, ever.

**What it stops accepting, it refuses by name.** A field, an environment
variable, a result field, an export, or a bin that is removed ships a shim that
names it and says what replaced it. Fields and variables — the two things a
caller states as data — are listed in `orchestration/removed-inputs.ts`;
everything else is refused where it is read, because there is no call to
intercept. A removed result field is a throwing getter, plus a spelled-out value
on the serialized edge a getter cannot cross; a removed export is a function
that throws; a removed bin is a stub that exits non-zero. A shape the table
cannot hold is not exempt — it is refused somewhere else.
[`CONTEXT.md`](./CONTEXT.md#invariants-worth-knowing-before-you-change-something)
has why a type-only removal is not one. Deleting the read is a regression, not
cleanup.

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
  `requiredSecrets` are caller-stated. **The class is broken, not intact with an
  exception**: the six label names are package-owned outright, and two of them —
  `ready-for-agent` and `ready-for-human` — name states in the consumer's own
  process rather than anything this package runs. Fixed names can be guaranteed;
  configurable ones could only be validated against bindings this package does
  not own, and one consumer spelling a label differently would silently undo the
  state machine. So the rule is narrower than "never name the consumer's
  things": a vocabulary this package owns, verifies, and refuses on, and no
  second one without the same argument being made again.
- **CI glue** — the caller keeps the checkout and the exit code, plus the
  setup-free admission job in front of `runPhase`. **Everything else moved
  in**: the harness owns the branch, the pull request, and the issue's state
  during a run, and `init` scaffolds the workflow template that wires the two
  jobs together — a starting point the consumer then owns, since nothing reads
  it back or keeps it in sync. The public surface is one verb:
  `runImplementAgent`, `runPreflight`, `postVerifyComment`, and
  `runPluginDirsCheck` are internals it composes, and the sequencing between
  them — the thing that was actually the interface — is now typed and tested
  rather than written in consumer bash.
- **The content of the agent's half of a handoff** — read back from a file the
  agent wrote, quoted verbatim, and marked as claims rather than restated as
  fact.
- **Evals** — a named, open gap, not an oversight to close casually.
