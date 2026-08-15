# Testing conventions

How this package is tested, and why in that shape. The short version lives in
[`CLAUDE.md`](../CLAUDE.md); this is the whole of it.

Vitest with `globals: true` — `describe` / `it` / `expect` / `vi` are ambient,
no imports. Tests sit beside their subject (`cli-version.ts` /
`cli-version.test.ts`).

## Assert on inputs and outputs of the pure functions

Every decision in this package is a pure function (see
[`CONTEXT.md`](../CONTEXT.md#pure-core-io-shell)), so its test is a table of
inputs and expected verdicts. Nothing needs to be mocked to reach it.

That is the point of the split, and it cuts both ways: **needing to mock `fs`,
`gh`, or a clock to test a decision means the decision is in the wrong half.**
Move it into the pure function rather than reaching for a mock.

## Don't assert on which branch produced a value

A `branch` resolved from the caller's input, from `BRANCH`, from `GITHUB_REF_NAME`,
and from a `git rev-parse` probe are the same result. Assert the result. A test
that asserts _which_ source answered locks in an implementation detail and
breaks on a refactor that changed nothing observable.

Precedence itself is fair game — that an explicit input beats an env var _is_
the contract. The distinction is asserting the ordering versus asserting the
plumbing.

## Wiring needs its own test

**A unit test on a pure function proves nothing about whether it is called.**

This repo shipped a wall-clock guard that was fully implemented, fully
unit-tested, exported, documented in the README, and required by the CLI — and
never called from a run. `resolveWallClockMs` had four passing tests. The suite
was green and the guard did not exist. See §1 of
[`harness-gap-analysis.md`](./harness-gap-analysis.md).

So every value a shell resolves gets a test that goes _through the shell_ and
asserts it reaches the thing that consumes it. `runImplementAgent guard wiring`
in `src/orchestration/implement.test.ts` is the model: it calls
`runImplementAgent` and asserts on what `spawnClaude` received.

When you add a config field, a budget, or a precondition, that wiring test is
part of the change — not a follow-up.

## Where mocking is allowed

Only in a shell's wiring tests, and only at the process boundary:
`spawnClaude`, `node:child_process`, `node:fs`, and transcript capture. Those
tests exist to prove the shell hands the right things across that boundary, so
the boundary is what they stub. The orchestrator's are the model; `probeSetup`'s
are the same shape one module over — a shell is a shell.

Prefer the real thing where the layout _is_ the thing under test:
`run-plugin-dirs.test.ts` and `probe-setup.test.ts` both write fixture files
into a temp directory rather than stubbing `fs`, because a stubbed filesystem
could only restate the layout the probe assumes instead of checking it.

Two rules hold there:

- **Stub the boundary, not the logic.** `describeRunawayKill` stays real — a
  stubbed one would let a test assert a failure message no run would ever print.
- Keep the stubbing in those files. A pure-function test that reaches for `vi.mock`
  is a design signal, not a testing need.

`spawn-claude.test.ts` goes further and spawns real short-lived `node -e`
child processes rather than mocking a stream, because the runaway guards are
timing behavior over a real process and a faked stream would only test the fake.

## What is not covered

Tests, not evals: deterministic correctness of these functions is covered;
nothing scores whether an actual agent run produced _good_ work. Named gap, not
an implied guarantee.
