---
---

Docs only — no release. `docs/sdlc-loop-design.md` and
`docs/harness-gap-analysis.md` described a state the package left behind at
`1.0.0`, and both are read as the record to file issues from, so overstating
what is open is a live cost rather than an untidy one.

The design doc's status said "settled, **unbuilt**"; it is built, and every one
of its ten sequencing steps, its Residual, and all seven review findings now
carry a note saying where each landed and — for finding 1 — what it did _not_
close. §8's create-at-startup is marked reversed by §11 in the same style §4,
§6, and §7's reversals already were. The "Also found" README duplicate is
recorded as fixed.

The gap analysis said "No `PreToolUse` blocking" while every spawn arms the
command guard through an inline `--settings` payload; §3.2 now says what it
blocks, what refusing an unarmed guard costs, and what is still missing. §3.1's
"there is no outer loop", §3.4's "no trajectory evaluation either", and §3.5's
"a failed run teaches the next one nothing" get the same treatment.

Nothing about the package's behaviour changed. Evals remain zero, and both
documents still say so — that is the one claim in them the code has not moved.
