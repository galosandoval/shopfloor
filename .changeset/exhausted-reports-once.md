---
'@galosandoval/shopfloor': patch
---

Four corrections to the outer loop's terminal state and the lock in front of it.

**The scaffolded `concurrency:` group now keys on the agent branch, not the
issue number.** `github.event.issue` is null on a `workflow_run` event, so the
previous group fell through to `github.run_id` — unique per run, excluding
nothing. The retrigger edge, the one edge that fires with no human on it, had no
mutual exclusion at all, behind a label narrowing that is explicitly not a lock:
two CI failures landing together on one agent branch could each start a run.
Both edges now resolve to the same `agent/issue-<n>` group. **This is a change to
the workflow template `init` scaffolds; an already-scaffolded workflow keeps the
old group until its `concurrency:` block is updated by hand.**

**`agent:exhausted` no longer posts without checking that the label exists.** The
report is made idempotent by the label being on the issue next time, so a
repository missing it re-posted the entire accumulated attempt trail on every
subsequent event on the branch — the comment generator the terminal state is
built to avoid, reached by the one failure that is both permanent and knowable
before writing anything. A refused vocabulary now writes nothing and says why; a
vocabulary check that could not run still reports, since not knowing is not the
same as knowing the label is missing.

**A branch that never carried a trail is reported as empty, not as evidence
lost.** An absent attempts directory and an empty one are both a 404 from the
contents API, and that is the ordinary first-attempt-exhausted case. It was being
reported as a failed read, so the loop's most-read comment claimed part of the
trail could not be retrieved for a trail that never existed. A real failure — a
broken token, an unreadable repository — still says so.

**`ExhaustionReportInput` extends `SpentCeiling`** rather than restating its five
fields. Callers that built the input by hand now also pass `repo`.
