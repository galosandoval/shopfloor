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

`npx changeset` — CI fails a PR that has none (only the `changeset-release/main`
PR is exempt). A PR that deliberately ships nothing — docs, CI config, tests —
records an explicit empty one, `npx changeset --empty`, so "this doesn't
release" is on the record rather than inferred from silence. Pre-`1.0.0`: write
the body for a consumer deciding whether the bump is safe, naming new failure
modes and what breaks, not just what was added.

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
[`CONTEXT.md`](./CONTEXT.md#standards-in-repo-procedures-in-skills). One thing
neither says: the public surface is `src/index.ts`, nothing else.

## What this package deliberately does not own

Each was decided against; don't add them.

- **Prompt content** beyond the harness's invocation defaults — per-consumer.
- **Opinionated coding standards for consumers** — `standardsDir` points at
  theirs. This repository's own standards are not shipped.
- **Consumer env-var names** — `requiredEnvVars` is caller-stated.
- **CI glue and workflow templates** — callers own `$GITHUB_OUTPUT`, exit codes,
  branch checkout, the PR.
- **Evals** — a named, open gap, not an oversight to close casually.

Multi-step procedures belong in skills, not in this file.
