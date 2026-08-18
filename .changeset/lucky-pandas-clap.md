---
'@galosandoval/shopfloor': minor
---

Add `classifyTrigger` and the setup-free admission callable (shopfloor#46).

Trigger logic lived in `if:` expressions and `env:` blocks in consumer YAML,
which destructures the webhook payload before anything typed can see it: which
event means which phase, and who may start one, could be neither typed nor
tested. The consumer now passes the **raw payload** and gets a verdict.

**New:**

- `classifyTrigger(payload)` — pure over the raw webhook payload. Returns the
  phase, issue number, actor, and repo for the two admitted edges
  (`issues.labeled` with `ready-for-agent`; `workflow_run.completed` with
  `conclusion: failure` on an `agent/issue-<n>` branch), or an explicit
  not-a-trigger verdict with a reason. It never throws — an unrecognized or
  malformed payload is the common case, not an error.
- `evaluateAdmission` / `runAdmission`, and the **`shopfloor-admit` bin** —
  classification, authorization, the concurrency check, and the attempt ceiling
  as one verdict, runnable by a job with nothing installed but this package and
  `gh`. The verdict is one line of JSON on stdout so a workflow can gate the
  expensive job on it.
- `agentBranchForIssue` / `issueNumberFromBranch` / `AGENT_BRANCH_PREFIX` — the
  `agent/issue-<n>` convention, now package-owned, so your glue and this package
  name the same branch instead of agreeing by eye.

**New failure modes, all of them refusals before any spend:**

- Admission **refuses on uncertainty**, like the spend gate it wraps and unlike
  every other guard here. An unreadable issue is `undetermined`, not "no
  attempts" — it is not knowing whether something is already spending. Give the
  probe a token that can read issues, or admission refuses every event.
- It refuses at three attempts per issue by default (`--max-attempts <n>`, or
  `maxAttempts`), and while the issue carries `agent:in-progress`. Both are new
  ceilings on a loop that previously had none. **The token needs issue read
  access** — the count comes from `gh api repos/…/issues/<n>/timeline` and
  `gh issue view`.

**Where the counts come from, and why it is not where the design said.** Both
are read off the issue: attempts is how many times `agent:in-progress` was ever
added (GitHub keeps `labeled` timeline events permanently, so this survives the
label being cleared and counts runs killed before cleanup), and in-flight is
whether that label is on the issue now. Design §4/§7 derive both from
`gh run list --branch`, which cannot work — a run triggered by `issues.labeled`
or `workflow_run` executes on the **default branch**, so a list filtered by
`agent/issue-<n>` is empty on every real run. Nothing new is written to make
this work; the `started` transition already adds the label.

**Read the concurrency check for exactly what it is:** a narrowing, not a lock.
A maintainer clearing a stuck `agent:in-progress` unlocks concurrent spending,
and two events landing together can both read it absent. Keep the
`concurrency:` group in your workflow — it is the real mutual exclusion, and
this does not replace it.

**`shopfloor-authorize` changes behaviour in two small ways.** A login ending
in `[bot]` is now probed rather than refused as malformed: the machine edge
triggers as an App, and `"github-actions[bot]" is not a GitHub login` was a
false reason. The endpoint answers for these logins with `permission: "none"`,
so **a bot actor still refuses** — as `not-permitted` now instead of
`undetermined`. If you authorize the loop's own retrigger today by some other
route, nothing changes; if you were relying on the `undetermined` spelling, it
moved. Separately, a refusal caused by `gh` being missing now says so rather
than reporting a bare `the permission probe failed`.

`shopfloor-authorize` otherwise still ships unchanged. Nothing here is wired into
`runImplementAgent`, and `runPhase` — the one verb that would call admission and
then run — is not built: this is the admission half, shipped first so the spend
gate never ends up behind the spend.
