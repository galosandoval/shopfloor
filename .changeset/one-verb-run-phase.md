---
'@galosandoval/shopfloor': minor
---

Collapse the loop to one verb, `runPhase(rawEvent)`, which now owns the branch,
the pull request, and the issue's state (shopfloor#47).

**This is a breaking surface change.** Four verbs are gone from the public
surface, and each maps to the same work happening inside `runPhase`:

| Removed              | Now                                                                                                                           |
| -------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `runImplementAgent`  | the phase's run, reached through `runPhase`; its config fields and `RunImplementAgentResult` are unchanged and still exported |
| `runPreflight`       | step 3 of `runPhase`, on the human edge; the pure `evaluatePreflight` still ships                                             |
| `postVerifyComment`  | step 9 of `runPhase`, best-effort as ever; the pure `buildVerifyComment` still ships                                          |
| `runPluginDirsCheck` | a pre-spawn precondition, as it already was; the pure `evaluatePluginDirs` still ships                                        |

The bin changes with it: **`shopfloor-implement <issue>` is replaced by
`shopfloor-run-phase`, which takes no arguments.** The issue, the phase, and the
actor come off `$GITHUB_EVENT_PATH`; the branch is `agent/issue-<n>`, computed
in the one place that name is written down. Its exit code splits the way
`shopfloor-admit`'s does — `not-a-trigger` exits zero, every other refusal and
every failed run exits non-zero.

**What the harness now writes to your repository during a run**, which it did
not before: it creates and pushes the branch, opens the draft PR, and moves the
issue's labels. Bounded three ways — only the branch it owns by name, only the
issue the payload named, and only after admission and preflight admitted the
run. Refusals still write nothing, except preflight's, whose refusal _is_ a
judgement about the issue. A run still creates no labels; that stays `init`'s.

**New failure modes, named:**

- A phase with no prompt **refuses at startup naming the phase**, before the
  branch, the transition, or a token. Prompts are keyed by phase now
  (`prompts: { implement }`); `PROMPT_FILE` still works and applies to whichever
  phase the payload discovered. Unstated, a phase runs on a shipped shim —
  `DEFAULT_PHASE_PROMPTS` — that defers to the bundled skills plugin and carries
  no procedure and no environment content of its own.
- An unreadable issue title now refuses the run: the prompt and the PR are named
  from one read so they cannot disagree.
- The run needs `git push` to succeed and permission to open a PR. A workflow
  checked out with `GITHUB_TOKEN` rather than a PAT will now fail where it
  previously handed the push back to your own YAML — and a push made with the
  built-in token fires no downstream events, so the machine edge stays dead.
- A failed run **pushes what it committed and then transitions before it
  throws**: `exhausted` when the inner loop spent its ceiling with the gate
  still red, `failed` otherwise. Both set `ready-for-human` — the transition
  this design exists because of, and the one that had never once fired. The
  push is best-effort and opens no PR; it exists so an ephemeral runner does not
  take the work with it. **Note what it can retrigger:** a pushed branch runs
  your CI, and CI going red on an agent branch is the machine edge. That loop is
  bounded by the attempt ceiling today, and is shopfloor#50's to settle
  properly.

**Migrating a workflow.** Delete the slug pipeline, the `gh pr create` step, and
every `gh issue edit` label swap; keep the checkout (with your PAT), the exit
code, and a setup-free `shopfloor-admit` job in front. `shopfloor init`
scaffolds exactly that shape. `runPhase` re-checks admission itself rather than
trusting the upstream job.
