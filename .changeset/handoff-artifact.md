---
'@galosandoval/shopfloor': minor
---

Attempts now leave memory for the next one: the handoff artifact (shopfloor#49).

Every run that does **not** succeed writes `.agent/attempts/<run-id>.md` and
commits it to the branch. The next attempt reads the whole trail through a new
`{{ATTEMPTS_DIR}}` prompt token — all of it, not just the last file. Without
this, iteration N+1 started cold, re-derived the same wrong approach, and spent
the ceiling doing it.

The document has two labeled halves and never blends them. The
**harness-authored** half is observed fact — a bounded tail of the failing CI
run's logs plus its URL, the trajectory scorecard, the run id, the diff — and is
written **unconditionally**, including after a runaway kill or a crash inside
the run. The **agent-authored** half is marked as unverified claims, read back
from a file the agent wrote at a new `{{HANDOFF_CLAIMS_FILE}}` token and quoted
verbatim; when the agent wrote none, the document says so rather than omitting
the section. Every section is bounded by an exported constant
(`HANDOFF_LOG_TAIL_LIMIT`, `HANDOFF_DIFF_LIMIT`, `HANDOFF_CLAIMS_LIMIT`) and a
truncated one says it was truncated.

**What breaks.** Two things, both in prompts:

- **`shopfloor-doctor`'s `prompt-tokens` check now fails on a prompt written
  before this release**, because `{{ATTEMPTS_DIR}}` and
  `{{HANDOFF_CLAIMS_FILE}}` are missing from it. A run does **not** refuse over
  a missing token — that rule is unchanged — but a prompt that never names them
  gets an agent that reads no trail and writes no claims, so the loop keeps its
  ceiling and loses its memory. Re-run `shopfloor init`, or add both tokens by
  hand; the shipped per-phase shim already carries them.
- The shipped `DEFAULT_PHASE_PROMPTS.implement` and the `shopfloor init` prompt
  skeleton both gained a section for each half. A consumer who copied either one
  should re-copy it.

**New failure modes.** The harness now commits files of its own to the branch it
owns — the handoff on a failure, and a strip commit on a success. Both are
authored as `claude-code[bot]` and use `--no-verify`: the machine edge is keyed
on the head commit's author, so an ambient identity here would silently stop the
retrigger, and a pre-commit hook failing is not a reason to lose the record. The
writes are path-limited to `attemptsDir` and are best-effort throughout — a
handoff that cannot be written or committed warns and never fails a run, and a
CI log fetch that fails degrades the document to URL-only. A repository whose
branch protection rejects those commits will see warnings on the failure path,
not new failures.

The diff summary is taken against the base branch `origin/HEAD` names, falling
back to `main`, and a diff that cannot be taken is reported as undetermined
rather than rendered as "nothing was committed".

Also new: `RunImplementAgentResult.findings` and `ImplementAgentError.findings`
carry the trajectory scorecard for the attempt, and every finished attempt is
now graded rather than only the ones that reached a green gate. `renderHandoff`,
`DEFAULT_ATTEMPTS_DIR`, `FailedPhaseOutcome`, and the three bounds are exported;
`classifyTrigger` and `evaluateAdmission` carry a `ciFailure` reference on the
machine edge; `attemptsDir` (env `ATTEMPTS_DIR`) and `handoffClaimsFile` are new
configuration fields.
