---
'@galosandoval/shopfloor': minor
---

Add the inner loop: a run can now retry itself in process, bounded by its own
budget.

State `runPolicy.gateCommand` (`GATE_COMMAND`) and `runImplementAgent` runs that
command itself after each spawn, in the run's `cwd`. A non-zero exit spawns the
CLI again with the failing command and a 4 KB tail of its output appended to the
prompt, up to `runPolicy.maxIterations` (`MAX_ITERATIONS`, default `3`). The
pure decision behind it, `evaluateIteration`, is exported. The result carries
`iterations`.

**The new failure mode, named: a run that previously spawned the CLI exactly
once may now spawn it repeatedly.** Everything a single run costs — tokens, API
spend, wall-clock, commits on the branch, transcript captures — multiplies by up
to `maxIterations`. Only a run that states a gate command can iterate, so
upgrading changes nothing until you state one; but a consumer who sets
`GATE_COMMAND` in CI is opting every run in that environment into up to three
spawns, and `MAX_ITERATIONS` is the one number bounding that. Nothing here reads
the gate from your prompt or infers one.

**`wallClockMinutes` now bounds the run, not one spawn.** Each iteration is
armed with what is left of the budget rather than a fresh copy of it, and the
gate's own runtime is charged to the same clock — so the ceiling covers spawns
and gates together. A run with under a minute left fails instead of spawning
again. A single-iteration run is armed exactly as before, so no existing
behaviour changes — but if you were reading that number as a per-spawn ceiling,
it is now a per-run one. `idleMinutes` is unchanged and stays per-spawn: silence
is a property of one live process.

**A spent budget with the gate still red fails the run**, throwing
`ImplementAgentError` naming the gate and the budget. The loop does not return
unvetted work as a success. A runaway kill or a non-zero CLI exit still fails
immediately and never iterates.

**A run that iterates writes extra transcripts.** `transcriptFile` still holds
the session that finished the run, and each failed attempt is now kept beside it
as `transcript.iteration-<n>.jsonl` before the next spawn overwrites it. If your
CI glue uploads the output directory wholesale it will pick these up; if it
uploads `transcriptFile` by name, nothing changes. `runTrajectoryCheck` still
grades `transcriptFile`. A run with no gate stated writes none of them.

The gate command runs through a shell in your checkout, on the run's own
environment — no OAuth token is injected into it and `ANTHROPIC_API_KEY` is not
stripped from it, since that pair constrains the agent's auth and the gate is
not the agent. Treat the command as the trusted configuration it is: it must
come from your own config, never from an issue, a comment, or anything the agent
wrote.

`RunImplementAgentResult` gains a required `iterations` field; a caller
constructing that type by hand (a test fixture, a stub) now has to supply it.
