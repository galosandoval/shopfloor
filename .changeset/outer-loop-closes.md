---
'@galosandoval/shopfloor': minor
---

The outer loop closes: runs can now trigger other runs, and the attempt ceiling
is what stops it (shopfloor#50).

**The new failure mode, plainly.** A failed attempt pushes its handoff commit,
CI goes red on the agent's branch, and that failure starts another run — without
a human. The bound on that is the attempt ceiling (`DEFAULT_MAX_ATTEMPTS`, 3;
`shopfloor-admit --max-attempts <n>` or `runPhase({ maxAttempts })` to change
it), derived from how many times `agent:in-progress` was ever added to the
issue. Three guards now exist and each is blind to the others' failure: idle
catches a stalled agent, wall-clock catches one looping within a run, and the
ceiling catches one looping across runs.

**A finished run's CI failure no longer retriggers, and this is a behaviour
change.** A successful run now always ends with a commit carrying a
`Shopfloor-Loop: closed` trailer — the one that strips the attempt trail, or an
empty one when there was no trail to strip — and the machine edge refuses a head
commit that has it. Expect one such commit on every agent branch that finished. Previously that commit's bot authorship made CI red on
top of a _finished_ run look like another failed attempt, which would spend an
attempt on work already handed to a human, starting cold, since the strip is
what removed the trail. A failed attempt's handoff commit carries no trailer and
still retriggers — that asymmetry is the loop. If you commit to an agent branch
from your own tooling and do not want it answered, write the trailer
(`LOOP_CLOSED_TRAILER`, exported) on its own line.

**A spent ceiling now lands a terminal state, where it previously landed
nothing.** The issue gets `agent:exhausted` — never `agent:blocked`; the two
mean _the work is harder than specified_ and _something is broken_, and they are
answered differently — plus the accumulated handoff trail as a comment. The
pull request stays open and the trail is not stripped. It reports once: the
label itself is what says the report already happened.

**One consequence for anyone wrapping the callables.** `shopfloor-admit` now
makes exactly one write, on the `exhausted` verdict. `runAdmission` still writes
nothing on any verdict — the write is a separate callable, `reportExhaustion`,
that the bin runs, and the `exhausted` refusal carries a new `ceiling` field
(`SpentCeiling`) with the facts it needs. It has to happen there because the
expensive job is gated on the verdict, so nothing downstream survives to apply a
row. It is reachable only after classification admitted a real trigger and, on
the human edge, the spend gate admitted the actor.

**Each attempt's handoff now states what it spent** — the four token buckets and
the cost from `usage` (shopfloor#42), with `source` saying whether that is the
CLI's own tally or a partial count the harness observed. The ceiling bounds
attempts; the argument for raising it is in tokens, and the trail a spent
ceiling posts is where a human reads both.

New exports: `reportExhaustion`, `buildExhaustionReport`,
`EXHAUSTION_COMMENT_LIMIT`, `LOOP_CLOSED_TRAILER`, `EXHAUSTED_LABEL`, and the
types `SpentCeiling`, `ExhaustionReport`, `ExhaustionReportInput`,
`TrailDocument`, `ReportExhaustionInput`, `ReportExhaustionResult`.

Two things design §4 asked for are deliberately **not** here, and the reasoning
is in `CONTEXT.md`: the ceiling is not a `runPolicy` field (admission runs
before a run policy exists), and the count is not a filtered `gh run list`
(that mechanism cannot fire — an `issues`- or `workflow_run`-triggered run
reports `head_branch: main`).
