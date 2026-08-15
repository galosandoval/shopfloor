---
'@galosandoval/shopfloor': minor
---

Add `shopfloor doctor` — one non-interactive command that says which of a
consumer's setup bindings is wrong.

Everything a consumer must get right to run this harness is an untyped string
binding that fails silently when it is wrong: two secrets, the label
vocabulary, the workflow's trigger wiring, a prompt carrying six exact
`{{TOKEN}}` placeholders, a CLI pin. `npx shopfloor-doctor` probes all of it
and names each failure.

**New bin: `shopfloor-doctor`.** Reads `PROMPT_FILE`, `WORKFLOW_FILE`
(default `.github/workflows/agent-implement.yml`), `REQUIRED_SECRETS`
(default `CLAUDE_CODE_OAUTH_TOKEN,AGENT_PAT`), `AGENT_PAT_SECRET`,
`CLI_VERSION`, and `GITHUB_REPOSITORY`. Read-only and idempotent — it creates
no labels, sets no secrets, and writes no files — and **exits non-zero on a
failing verdict**, so a CI step can gate on it.

**New API:** `evaluateSetup` (pure verdict over gathered facts), `probeSetup`
(the IO shell), `formatSetupReport`, and the constants a consumer can act on —
`REQUIRED_LABELS`, `PROMPT_TOKENS`, `ENVIRONMENT_BLOCK_START` /
`ENVIRONMENT_BLOCK_END` / `ENVIRONMENT_UNFILLED_SENTINEL` — plus the
`SetupFacts` / `SetupVerdict` / `SetupCheck` / `DoctorConfig` types. The check
ids, the admitted events, and the config defaults stay internal on purpose.

**Nothing about an existing run changes.** No new refusal, no new precondition,
no behaviour change to `runImplementAgent`; this is additive, and a consumer
who never runs the doctor is unaffected.

**Failure modes worth knowing before you gate CI on it.**

- **Three statuses, and only `fail` sets the exit code.** A check whose probe
  answered nothing — `gh` absent, no `PROMPT_FILE` pointed at, no pin stated —
  reports `unknown` and passes. A green doctor therefore means "nothing was
  found wrong", not "everything was checked": read the unchecked list.
- **The workflow's `on:` block is read by a shallow scan, not a YAML parser.**
  Trigger wiring written in an unusual shape can read as absent, which surfaces
  as a `workflow-triggers` failure. It errs toward reporting a problem, never
  toward a silent pass.
- **Two checks need network access** — the default branch's workflow files come
  from the GitHub API, because `workflow_run` fires only from the default
  branch and the local checkout usually isn't it. Offline, that check reports
  `unknown`.
- **Two checks fail on a setup that is correct for the harness as it ships
  today.** `workflow-triggers` requires `workflow_run.completed`, the outer
  loop's machine edge, which is designed and unbuilt; `label-vocabulary`
  requires six fixed labels nothing creates yet. Both are the loop's real
  bindings, and both will fail a consumer running only the `implement` phase
  until those land — read the report before wiring the exit code into a
  blocking CI step.
- **A green `pat-workflow-scope` is an inference, not proof.** A stored
  secret's scopes cannot be read by anything but Actions, so the check judges
  the token the operator is running as. A correctly-scoped laptop with a
  wrongly-scoped `AGENT_PAT` passes.
- **The PAT half of `workflow-run-prerequisites` is a reference check** — it
  asks whether the workflow mentions `secrets.<PAT>` at all, not whether the
  pushing step uses it.
- **Environment-scoped secrets read as missing.** Repository and organization
  secrets are both probed; environment secrets are invisible to `gh secret
list`, so name only visible secrets in `REQUIRED_SECRETS`.
