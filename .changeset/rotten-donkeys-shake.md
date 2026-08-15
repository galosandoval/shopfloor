---
'@galosandoval/shopfloor': minor
---

Add the trajectory checker: the harness now grades its own finished runs.

`runTrajectoryCheck({ transcriptFile, maxTurns })` reads a captured session
transcript and grades it against four process invariants — `gate-before-commit`,
`red-before-green`, `no-forbidden-git-ops`, `turn-budget-headroom` — returning
findings plus a rendered markdown scorecard, and optionally writing it to a
`scorecardFile` for `gh pr comment --body-file`. The pure half
(`checkTrajectory`, `formatScorecard`) is exported for callers assembling their
own reporting.

**Advisory only.** It reports; it never fails a run, never throws, and never
changes an exit code. A missing or unreadable transcript returns
`graded: false`; an empty or truncated one grades every invariant
`not-evaluable`. Gating on these findings is a separate, later change — if you
build one on top of this, you own that decision, not the package.

New failure mode to know about: **`gate-before-commit` and `red-before-green`
depend on recognizing your test command.** The default patterns match a
whole-suite run under npm, pnpm, yarn, or bun (and jest/vitest invoked
directly), and deliberately exclude partial scripts like `test:e2e`. A repo
whose gate is anything else — `make check`, a bespoke script — will score
`gate-before-commit` as a fail on a perfectly good run unless it states
`gateCommandPatterns`, which replaces the defaults outright. Read the scorecard
against your own gate before drawing conclusions from it.

Nothing existing changes: no behaviour of `runImplementAgent` is affected, and
this ships no new required input.
