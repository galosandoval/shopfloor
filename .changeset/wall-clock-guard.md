---
'@galosandoval/shopfloor': minor
---

Enforce the wall-clock runaway guard.

**Behavior change — a previously inert budget now terminates runs.**
`runPolicy.wallClockMinutes` (`WALL_CLOCK_MINUTES`) was typed, documented, and
read by nothing; a run had no time ceiling regardless of its value. It is now
enforced. A run that already sets the budget and quietly went well past it will
start failing at the stated ceiling, with no type error to warn you — check the
value before upgrading. Nothing changes for a run that sets no budget: the
wall-clock guard is armed only when one is stated, since a fabricated default
would kill runs no caller asked to bound.

`LOCAL_WALL_CLOCK_MINUTES`, documented as a single-run override, starts working
for the first time as a side effect.

A wall-clock kill sends `SIGTERM`, waits 30 seconds, then `SIGKILL`s, so a
looping agent can flush uncommitted work. The idle guard still goes straight to
`SIGKILL` — a stalled agent usually cannot service a signal handler — with one
incidental change: the guards now disarm on the first kill, where the idle guard
previously re-sent `SIGKILL` on every 15-second tick until the child died. The
resulting `ImplementAgentError` names which budget tripped, and the transcript
is captured either way. A killed run remains a hard failure even when the agent
had already committed: it never reached its verify phase, so those commits are
unvetted work-in-progress.
