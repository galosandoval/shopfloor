---
'@galosandoval/shopfloor': minor
---

Trajectory becomes a closure condition on the success path (#48)

A green quality gate is no longer sufficient for a run to succeed. Every
attempt is now graded against the trajectory checker before `runPhase` may
finish, so an agent that reached green by deleting a failing test does not exit
as a success.

Two of the four invariants gate — `gate-before-commit` and `red-before-green`.
`no-forbidden-git-ops` and `turn-budget-headroom` stay advisory (the first is
already refused at spawn time by the command guard; the second is a capacity
signal, not a process violation). The list is exported as
`GATING_TRAJECTORY_INVARIANTS`.

**New failure modes — read this before upgrading.** Runs that previously
reached `ready-for-human` may now block:

- A run whose trajectory violates a gating invariant re-enters the loop with
  the violation appended to the prompt, spending from the same `maxIterations`
  and wall-clock budget a red gate does. With the budget spent it **fails**:
  `agent:blocked` + `ready-for-human`, the branch pushed, no PR, and a comment
  on the issue naming the invariants. Deliberately not `agent:exhausted`.
- **An attempt whose session transcript was not captured, or is unreadable,
  blocks the run.** This is the one guardrail here that refuses on an
  unreadable signal without being about spend: a definition of done that an
  absent file satisfies is not one. If your transcript capture does not work —
  a `projectsDir` pointing somewhere the CLI does not write, a sandbox that
  discards it — every run will now block rather than succeed. **Check
  `transcriptCaptured` on a run result before upgrading.**
- **A run with no `runPolicy.gateCommand` can now iterate.** Previously such a
  run was always single-shot. It still is unless its trajectory fails to close;
  the trajectory is a second signal and needs no configuration. A gateless run
  can therefore now spawn up to `maxIterations` times and cost proportionally
  more.

Grading uses the package's default gate-command patterns _plus_ your own
`runPolicy.gateCommand` matched literally, so a repository whose gate is not a
bare test command (`make check`, a bespoke script) is graded on the command the
harness actually runs rather than falsely flagged.

New API: `evaluateClosure` (pure — scorecard and remaining budget in,
`pass` / `re-enter` / `block` out), `GATING_TRAJECTORY_INVARIANTS`, and the
`ClosureInput` / `ClosureVerdict` / `GatingTrajectoryInvariantId` /
`ClosureBlock` types. `ImplementAgentError` gains an optional `closure` field
carrying the block, so a caller can tell a violated invariant apart from an
unreadable transcript without matching on the message.
