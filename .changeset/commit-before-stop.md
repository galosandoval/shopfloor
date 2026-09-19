---
"@galosandoval/shopfloor": major
---

**A run that never commits no longer closes as a success.** A new trajectory invariant, `commit-before-stop`, fails an attempt whose transcript carries no `git commit`, and it gates — so an attempt with budget left re-enters the loop carrying the violation, and one without lands `agent:blocked`.

The failure it was added for: an agent implemented the issue, passed the quality gate, and then ended its turn saying it would wait for a background test run to finish. A headless spawn has no turn after that one, so the working tree was discarded and the branch kept nothing. Nothing in the scorecard noticed — `gate-before-commit` passes *vacuously* on a run with no commits, `red-before-green` grades `not-evaluable` without a first commit to measure against, and `turn-budget-headroom` saw a run that had used 80% of its turns, most of them idling. The run failed on the terminal zero-commit check with no attempt spent trying to recover.

It gates rather than advises because it is the one gating invariant the loop can actually fix. The work was done and the gate was green; what is missing is a commit the next attempt can be told to make.

- **The shipped `implement` shim now says the run is headless** — that nothing reads the agent's output between turns, that there is no turn after the one it stops on, and that only what it committed on the branch survives. That is a fact about the run rather than a judgement about the work, which is the same line the gate-failure feedback sits on; what to *do* about it stays in the skills plugin.
- **The bundled plugin is repinned to `galosandoval/skills#v2.0.0`**, which carries `/implement`'s new commit discipline for unattended runs. The previous pin's skill ended on "Wait for the user to approve the work before committing" — correct with a human in the loop, and the instruction the agent above was obeying.

**Breaking.** `TrajectoryInvariantId` and `GatingTrajectoryInvariantId` each gain a member, so an exhaustive `switch` over either stops compiling. Runs that previously closed green without committing now re-enter the loop or block.
