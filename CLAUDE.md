# CLAUDE.md

`@galosandoval/shopfloor` — a typed, tested harness that spawns the Claude Code
CLI headlessly to implement a labeled GitHub issue as a draft PR. Library +
thin bin, no framework. Node 20+, ESM, TypeScript, vitest, tsup. Scripts are in
`package.json`; CI (`.github/workflows/release.yml`) runs lint, typecheck, test,
and build.

- [`CONTEXT.md`](./CONTEXT.md) — architecture, module map, run flow, invariants.
- [`docs/testing.md`](./docs/testing.md) — read before writing a test.
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

Follow the `coding-standards` skill (`~/.claude/skills/coding-standards/`);
`references/typescript-style.md` and `references/doc-comments.md` apply. Two it
won't tell you: doc comments carry the why-not — rejected alternatives and
deliberate asymmetries go at the declaration, which is what makes the guardrails
auditable — and the public surface is `src/index.ts`, nothing else.

## What this package deliberately does not own

Each was decided against; don't add them.

- **Prompt content** beyond the harness's invocation defaults — per-consumer.
- **Opinionated coding standards** — `standardsDir` points at the consumer's.
- **Consumer env-var names** — `requiredEnvVars` is caller-stated.
- **CI glue and workflow templates** — callers own `$GITHUB_OUTPUT`, exit codes,
  branch checkout, the PR.
- **Evals** — a named, open gap, not an oversight to close casually.

Multi-step procedures belong in skills, not in this file.
