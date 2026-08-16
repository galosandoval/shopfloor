# @galosandoval/shopfloor

## 0.16.0

### Minor Changes

- [#69](https://github.com/galosandoval/shopfloor/pull/69) [`1459347`](https://github.com/galosandoval/shopfloor/commit/145934727c320f79b160993304758078c3ef99e3) Thanks [@galosandoval](https://github.com/galosandoval)! - Label vocabulary + pure state transition table, with verify-and-refuse at
  startup (shopfloor#45).

  **What breaks.** A run against a repository missing any of the six labels now
  **fails before the spawn**, naming every one that is absent, where it
  previously started and silently skipped the transition later. So does a run
  whose `gh label list` cannot be read at all — that refusal says "could not be
  read" rather than naming labels, because an unauthenticated `gh` and an
  unconfigured repository are different things to go fix. If you are on `0.10.x`
  and have never run `npx shopfloor-init`, expect this to fail your next run:
  `npx shopfloor-doctor` shows the gap, `npx shopfloor-init` creates what is
  missing. This is deliberate. In the live consumer, a workflow step swapping
  `ready-for-agent` for `ready-for-human` had failed on _every_ successful run
  since it was written — the label did not exist and `|| true` swallowed it — so
  a transition the pipeline claimed to make had never once happened.

  `runPreflight` fails the same way, and for the same reason: it applies the
  `refused` row, and it is a public entry point `runImplementAgent` never calls,
  so a job running it as its own CI step inherits none of the run's startup
  checks. It now verifies the vocabulary as its first act — before it reads the
  issue — and **throws** `ImplementAgentError` rather than returning a refused
  verdict. The two are different failures: a verdict says the issue must not be
  implemented and is answered by labelling it, which is exactly the write an
  unconfigured repository cannot be trusted with. If you call `runPreflight`
  against a repository lacking a label, expect a throw where you previously got a
  verdict — and previously got a label transition that silently did not happen.
  A job running preflight and the run pays for the `gh label list` probe twice.

  The check **verifies and never creates**: creating labels is a durable write to
  a shared human workspace, and it stays with `init`, at a moment a human asked
  for it. It is the last precondition before the CLI probe, so every local check
  gets to refuse for free first.

  **Also new to a preflight refusal.** `runPreflight` no longer carries
  `agent:implement` / `agent:blocked` as string literals; it applies the
  `refused` row of the transition table, which additionally sets
  `ready-for-human` and drops `ready-for-agent`. It now reads the issue's labels
  (on the `gh issue view` it already made) rather than assuming them, so it never
  re-adds a label the issue already has, and a `gh` failure there surfaces
  instead of being swallowed.

  **Its comment text changed, and the old one was wrong.** A refusal used to say
  "re-add `agent:implement` to retry". The scaffolded workflow triggers on
  `ready-for-agent`, and GitHub fires `issues.labeled` only when a label is
  _added_ — so following that instruction relabelled the issue without
  retriggering anything. It now names `ready-for-agent` (exported as
  `ENTRY_LABEL`) and states the labels the transition left behind.

  **New exports.** `LABEL_VOCABULARY` and `REQUIRED_LABELS` move out of the
  doctor module onto their own — same names, same values, still exported from the
  package root, so no import changes. Alongside them: `ENTRY_LABEL`,
  `applyLabelTransition`
  (the `gh` shell), the pure `evaluateLabelTransition` with `TRANSITION_TABLE`
  and `RUN_OUTCOMES`, and `evaluateLabelVocabulary` /
  `runLabelVocabularyCheck` behind the new precondition.

  Every outcome the harness can produce has exactly one row, `ready-for-human`
  included — it is set by every terminal outcome, whatever the run produced. Each
  row is a target set rather than a list of edits, so applying one twice writes
  nothing the second time, and labels outside the vocabulary are never touched.
  This package applies exactly one row itself today (`refused`); `started`,
  `succeeded`, `exhausted`, and `failed` are yours to apply from CI glue, which
  is what the exports are for.

## 0.15.0

### Minor Changes

- [#67](https://github.com/galosandoval/shopfloor/pull/67) [`9d1fb81`](https://github.com/galosandoval/shopfloor/commit/9d1fb814009315b6dcc03080887dda26f075c6c8) Thanks [@galosandoval](https://github.com/galosandoval)! - A run refuses before spawning when its prompt was never filled in
  (shopfloor#44).

  **New failure mode: a prompt that previously ran now refuses.** Two things in
  the prompt template fail the run among the pre-spawn preconditions, before any
  `git` or `gh` probe and before a single token is spent:

  - **`TODO(shopfloor)`** — the sentinel `shopfloor init` writes wherever it could
    not read a value off your project. The refusal names the lines it is on.
  - **A `{{TOKEN}}` outside the six this package substitutes** — `{{ISSUE_NUMBER}}`,
    `{{ISSUE_TITLE}}`, `{{BRANCH}}`, `{{PR_DESCRIPTION_FILE}}`,
    `{{VERIFY_REPORT_FILE}}`, `{{SCREENSHOTS_DIR}}`. A misspelling, or a token that
    used to exist — `{{STANDARDS_DIR}}` is the live case. The refusal names each
    offender beside the table of real ones.

  Both previously ran. An unrecognized token rendered as literal text, unchanged
  and unreported, so an unfilled placeholder was indistinguishable from prose: a
  consumer who skipped filling the environment block paid for a whole run that
  then failed on a command their repository does not have. The refusal is the
  design's last open item, and it is why `init` writes a sentinel rather than a
  plausible default.

  **Is the bump safe for you?** A template with no sentinel, carrying only the six
  tokens spelled exactly as above, is unaffected. `npx shopfloor-doctor` reports
  most of the rest without spending anything — but a green doctor is not proof,
  because the run is the stricter check of the two: the doctor looks for the
  sentinel only inside the environment fences and tolerates spaces and
  lower-casing in a token, while the run refuses on the sentinel **anywhere** in
  the prompt and on `{{ ISSUE_NUMBER }}` or `{{issue_number}}` as readily as on a
  misspelling — the renderer substitutes none of them, so all three would have
  reached the agent as literal text.

  **The doctor's wording changed to match.** Its `prompt-tokens` check used to
  report an unrecognized token as one that "renders as literal text, unchanged and
  unreported"; that is no longer true of any run, so it now reports one that
  "nothing substitutes, so a run refuses before spawning". Same check, same
  pass/fail, new detail string — worth knowing only if you assert on the doctor's
  text.

  **What still does not refuse:** a _missing_ token. Leaving one out is a choice
  this package does not second-guess — the doctor reports it, a run does not
  refuse over it. And the check reads the template rather than the rendered
  prompt, so a `{{...}}` that arrives inside an issue title is the issue's data
  and never blocks the loop.

  **New export: `evaluatePromptReadiness`** — the pure verdict, over prompt text
  and a token table, for tooling that wants to ask before a run does.

## 0.14.0

### Minor Changes

- [#64](https://github.com/galosandoval/shopfloor/pull/64) [`6da6ed6`](https://github.com/galosandoval/shopfloor/commit/6da6ed643ae254f8d0a832f5e81369dcbf66517c) Thanks [@galosandoval](https://github.com/galosandoval)! - `shopfloor init` — one command from an empty repository to a working loop
  (shopfloor#43).

  **New bin: `shopfloor-init`.** `doctor` tells you what is wrong with your setup;
  `init` fixes the half a command can. It runs `doctor`'s evaluation first and
  writes only what that verdict says is missing: the six labels, the workflow
  wired to `issues.labeled` and `workflow_run.completed`, and the prompt carrying
  the six substituted tokens.

  **The environment block is filled, not left as a placeholder.** `init` reads
  your lockfile (`bun.lock`, `pnpm-lock.yaml`, `yarn.lock`, `package-lock.json`)
  and your `package.json` scripts, and writes the install command and the gate —
  `pnpm run typecheck && pnpm run test` — into the prompt's fenced environment
  block. Where it cannot determine a value it writes the `TODO(shopfloor)`
  sentinel, which `doctor`'s `prompt-environment-block` check already fails on.
  Never an empty string and never prose: a scaffold that emitted a plausible
  default would replicate the `standardsDir` failure shape in the one file a run
  cannot work without.

  **New check: `workflow-unfilled`.** The same sentinel names what `init` cannot
  know about the workflow — the `workflow_run` source, and the `claude` version
  when no `CLI_VERSION` is stated — and this check is what refuses on it. Read
  this as a new failure you will see: **a repository `init` just scaffolded fails
  `doctor` on `workflow-unfilled` until you replace those values.** That is the
  point. Without it a scaffolded workflow reads fully green while its machine
  edge is dead, because a `workflow_run` block whose `workflows:` names a
  sentinel is still wired to the event and passes `workflow-triggers`. If you
  consume `SetupCheckId`, it has gained a member.

  **This is the first thing in this package that writes to your repository**, so
  the constraints matter as much as the capability:

  - **Re-runnable.** A second run on a configured repository writes nothing.
  - **Never a silent overwrite.** An existing file is left alone or rewritten only
    after you confirm it by name. With no TTY attached — in CI — every overwrite
    is declined, so this is safe to run there, though a fresh repository will
    still have labels created and files scaffolded.
  - **An unreadable `gh` creates nothing.** A label probe that answered `unknown`
    is not evidence of a missing label, and creating six on no evidence is a
    durable write to a shared human workspace.
  - **A prompt whose environment `init` cannot account for is left alone.** No
    fences means the environment is prose this command cannot locate. A rewrite
    for a missing _token_ keeps an already-filled block verbatim rather than
    rebuilding it. And a block still carrying the sentinel on a project that
    states nothing to fill it with is skipped, not re-derived — otherwise every
    run would ask you to approve an overwrite of a file `init` itself wrote.

  What `init` does not do, and names in its report instead: set secrets,
  authenticate `gh`, or merge the scaffolded workflow to your default branch —
  without which the `workflow_run` edge cannot fire. Every planned write carries
  the reason it is there, and the merge rides on the action that creates the need
  for it, because with no workflow on disk the doctor reports that check unknown
  rather than failing and nothing else would say it.

  **The scaffolded workflow is a starting point you own**, wired to both events,
  checking out with the PAT, running the spend gate first, and **installing the
  `claude` CLI** — the harness spawns it from PATH, and nothing else on a fresh
  runner puts it there, so a scaffold without that step produced a workflow that
  could not run. Both `npx` invocations and that install are pinned: to the
  version of this package doing the scaffolding, and to your `CLI_VERSION`. Its
  job condition filters the label on `issues` without filtering `workflow_run`
  out of existence — `github.event.label` is null on that event, so a bare label
  condition would ship a workflow that passes its own doctor with the loop half
  of it dead. Three things in it are inert by design and marked with the
  sentinel: the CI workflow whose completion retriggers the loop, the CLI version
  when you state none, and how a `workflow_run` event resolves to an issue number
  — the outer loop, designed and not shipped.

  **The six labels are created with a colour and a description**, not as bare
  names GitHub then colours at random.

  **New exports:** `runInit`, `formatInitResult`, `LABEL_VOCABULARY` with the
  `LabelDefinition` type, and the types `RunInitInput`, `RunInitResult`,
  `InitPlan`, `InitAction`, `CreateLabelsAction`, `WriteFileAction`, `InitSkip`.
  The planner, the scaffold builders, and the project probe stay internal — the
  command is the surface. **`REQUIRED_LABELS` is now `readonly string[]`** rather
  than a literal tuple, derived from `LABEL_VOCABULARY`; code that depended on
  the literal member types will need widening.

  **Two scope lines in `CLAUDE.md` are amended** rather than quietly stretched:
  the package now ships a prompt _skeleton_ (a shim to the skills plugin — the
  content is still read off your project, never shipped) and a workflow template
  (a starting point you then own; nothing reads it back). Label creation lands
  here, at a moment a human asked for it, which is where design §11 puts it — but
  nothing is being removed from a run: no run has ever created a label, and a
  run's side stays verify-and-refuse. No existing behaviour changes.

## 0.13.0

### Minor Changes

- [#62](https://github.com/galosandoval/shopfloor/pull/62) [`b099715`](https://github.com/galosandoval/shopfloor/commit/b0997151073ca8c12744085e18033cfbcef6e91f) Thanks [@galosandoval](https://github.com/galosandoval)! - A run now reports what it cost (shopfloor#42).

  **New field on the run result: `usage`.** The CLI's `stream-json` output already
  flowed through the harness process — the idle guard reads it as a heartbeat —
  and every byte of it was dropped. It is now parsed as it arrives, and
  `RunImplementAgentResult.usage` carries the tokens (`inputTokens`,
  `outputTokens`, `cacheCreationInputTokens`, `cacheReadInputTokens`), the
  `costUsd` where the stream reports one, and a `source` field. `RunUsage` and
  `TokenUsage` are exported.

  This lands before the outer loop deliberately, not after it: the inner loop
  shipped in 0.11.0 multiplies spend by N and bounds a run by attempts, which is a
  ceiling on the wrong axis. Nothing in this package acts on the numbers yet — the
  consumer is your CI glue, and evals.

  **Read `source` before treating the numbers as a total.** `'reported'` means
  every spawn reached its terminal `result` event and these are the CLI's own
  figures. `'observed'` means at least one did not — a run a guard killed, or one
  whose stream was unreadable — and the totals are then the harness's own sum over
  the `assistant` messages it watched go by, each counted at the snapshot taken
  when its message started. **That sum is not a total, and not uniformly a floor.**
  `outputTokens` and `cacheCreationInputTokens` undercount, since the snapshot
  precedes the message's final count and a run killed mid-message contributes
  nothing. `inputTokens` and `cacheReadInputTokens` overcount, usually by a lot:
  every turn re-sends the conversation, so summing across N turns counts the same
  prefix up to N times. A run that iterated reports the sum across its iterations,
  and degrades to `'observed'` if any single iteration did.

  A `'observed'` total carries no `costUsd` even where one was seen: a cost covers
  a whole session, and a complete price beside an incomplete token count is
  exactly the misreading `source` exists to prevent.

  **`ImplementAgentError` gained a `usage` field**, so a failed run reports its
  spend too — a guard kill, a non-zero CLI exit, an exhausted attempt ceiling, and
  a run that committed nothing all spent real tokens and all leave by throwing. It
  is `undefined` only for a failure that refused before the spawn.

  **No new failure mode.** Metering never fails a run: a malformed or unrecognized
  line is skipped, and a run whose stream said nothing about usage reports zeroes
  with `source: 'observed'` rather than absence — so "free" is never confused with
  "unmeasured".

  Two things to know if you depend on the surrounding behaviour. `usage` is
  non-optional on `RunImplementAgentResult`, so a hand-built result object (a test
  double, say) will not typecheck until it carries one. And `SpawnClaudeResult`
  gained the same field — internal, but it is what the orchestrator's wiring tests
  construct.

## 0.12.0

### Minor Changes

- Sharpen the authorization guard shipped in 0.11.0 (shopfloor#41).

  **Breaking for anyone constructing an `AuthorizationInput` by hand.**
  `PermissionProbe`'s discriminant is now `answered`, not `read`: `read` is also
  one of the permission levels being judged, and `{ read: true, permission:
'read' }` reads as a contradiction it is not. `AuthorizationInput.probe` is now
  optional — omit it and the verdict is `undetermined` with "the permission was
  never probed", which is what a caller that skipped the probe should get rather
  than a probe result invented on its behalf. Callers of `runAuthorization` (the
  shell) and of `shopfloor-authorize` (the bin) are unaffected; only direct
  callers of the pure `evaluateAuthorization` need to rename the field.

  **The probe now reads `role_name`.** `runAuthorization` shells
  `gh api repos/{repo}/collaborators/{actor}/permission --jq '.role_name //
.permission'`. The endpoint's legacy `permission` field reports only `admin` /
  `write` / `read` / `none`, which collapses `maintain` into `write` and `triage`
  into `read` and makes two of the levels this guard distinguishes unreachable.
  An API old enough not to send `role_name` falls back to `permission` rather
  than refusing.

  **New failure mode: custom repository roles are now refused.** An
  organization's custom role arrives as a name this guard has never seen, so its
  holder is `undetermined` and the run stops — deliberate, given the guard
  refuses on uncertainty, but it will stop a run that the previous
  `permission`-field probe would have allowed. If your org uses custom roles,
  check that the actors triggering runs hold `admin`, `maintain`, or `write`
  directly.

  An authorized verdict's `permission` is now the exported `SpendingPermission`
  union rather than `string`, so a caller switching on it gets exhaustiveness
  from the compiler.

  One internal move rides along: `asExecFailure` in `src/process/` is now the
  single narrowing of a rejected `execFile`, shared by the doctor's probe and
  this one, along with the `node:child_process` stub their wiring tests use. Not
  exported; nothing about the public surface changes there.

## 0.11.0

### Minor Changes

- [#58](https://github.com/galosandoval/shopfloor/pull/58) [`7ec0942`](https://github.com/galosandoval/shopfloor/commit/7ec0942bcb2271d9f37efad251b2c6d25c0423ec) Thanks [@galosandoval](https://github.com/galosandoval)! - Add the authorization guard — the spend gate (shopfloor#41).

  On a public repository, anyone who can add a label can start a run that spends
  the maintainer's Claude subscription. Until now the only thing standing between
  a stranger and that spend was a line of YAML in each consumer's workflow
  (`github.actor == '<name>'`), with no test anywhere. This ships it as a typed,
  tested guard.

  **New API.** `evaluateAuthorization` (pure: probed permission + actor → verdict)
  and `runAuthorization` (the shell: probes
  `gh api repos/{repo}/collaborators/{actor}/permission`, returns the verdict,
  writes nothing). `SPENDING_PERMISSIONS` and the input/verdict types are exported
  alongside them.

  **New bin: `shopfloor-authorize`.** Prints the verdict and exits non-zero on any
  refusal, so a job that has installed nothing can run it first:

  ```yaml
  - run: npx -y @galosandoval/shopfloor@<version> shopfloor-authorize
  ```

  `GITHUB_ACTOR` and `GITHUB_REPOSITORY` come from the runner; `GH_TOKEN` must be
  able to read the repository's collaborator permissions. A spend gate that runs
  after the runner's setup has already let the spend happen, which is why it is
  its own bin rather than a step inside the existing ones.

  **New failure mode, and it is deliberate: this guard refuses on uncertainty.**
  Every other guardrail in this package proceeds when its signal is unreadable,
  because a missing diagnostic should not cause an outage. This one does the
  opposite — an errored probe, an empty answer, or a permission level it does not
  recognize all refuse. Concretely, a run triggered by an authorized maintainer
  will now **fail** if `gh` is missing, unauthenticated, rate-limited, or the
  token cannot read collaborator permissions. That is the intended direction: an
  unreadable permission is not permission. The verdict distinguishes
  `not-permitted` (the probe answered no) from `undetermined` (it answered
  nothing usable), so a broken token is not reported as a trespasser.

  Only `admin`, `maintain`, and `write` may spend — a `triage` collaborator can
  add a label, and labeling is not spending. That set (`SPENDING_PERMISSIONS`,
  exported) is fixed rather than configurable, for the reason the label
  vocabulary is: a stated set could only be validated against a role model this
  package does not own, and one consumer writing `['read']` would undo the guard
  with no error anywhere. An actor or repository that is not a well-formed GitHub
  login / `owner/repo` is `undetermined` and never probed.

  Nothing existing changes: no current export, verb, or run behaviour is touched,
  and a consumer who does not call the new guard is unaffected. Consumers should
  replace their workflow's `github.actor == '<name>'` condition with a setup-free
  job running `shopfloor-authorize`; the YAML check is not deleted by this
  release, since it is in the consumer's repository.

- [#57](https://github.com/galosandoval/shopfloor/pull/57) [`5c9010f`](https://github.com/galosandoval/shopfloor/commit/5c9010f5ad21404bc4d3f152aed4413028a2ea66) Thanks [@galosandoval](https://github.com/galosandoval)! - Add the inner loop: a run can now retry itself in process, bounded by its own
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

## 0.10.0

### Minor Changes

- [#55](https://github.com/galosandoval/shopfloor/pull/55) [`6f4133d`](https://github.com/galosandoval/shopfloor/commit/6f4133d49fb85daebe048a3623440ca8117ef1ef) Thanks [@galosandoval](https://github.com/galosandoval)! - Add `shopfloor doctor` — one non-interactive command that says which of a
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

## 0.9.0

### Minor Changes

- [#53](https://github.com/galosandoval/shopfloor/pull/53) [`cb37815`](https://github.com/galosandoval/shopfloor/commit/cb3781541b1e0e32e22d4c4a71e5f43ba93d82dd) Thanks [@galosandoval](https://github.com/galosandoval)! - Add the trajectory checker: the harness now grades its own finished runs.

  `runTrajectoryCheck({ transcriptFile, maxTurns })` reads a captured session
  transcript and grades it against four process invariants — `gate-before-commit`,
  `red-before-green`, `no-forbidden-git-ops`, `turn-budget-headroom` — returning
  findings plus a rendered markdown scorecard, and optionally writing it to a
  `scorecardFile` for `gh pr comment --body-file`. The pure half
  (`checkTrajectory`, `formatScorecard`) is exported for callers assembling their
  own reporting.

  **Advisory only.** It reports; it never fails a run, never throws, and never
  changes an exit code. A missing or unreadable transcript returns
  `graded: false`; an empty or truncated one grades every invariant
  `not-evaluable`. Gating on these findings is a separate, later change — if you
  build one on top of this, you own that decision, not the package.

  New failure mode to know about: **`gate-before-commit` and `red-before-green`
  depend on recognizing your test command.** The default patterns match a
  whole-suite run under npm, pnpm, yarn, or bun (and jest/vitest invoked
  directly), and deliberately exclude partial scripts like `test:e2e`. A repo
  whose gate is anything else — `make check`, a bespoke script — will score
  `gate-before-commit` as a fail on a perfectly good run unless it states
  `gateCommandPatterns`, which replaces the defaults outright. Read the scorecard
  against your own gate before drawing conclusions from it.

  Nothing existing changes: no behaviour of `runImplementAgent` is affected, and
  this ships no new required input.

## 0.8.1

### Patch Changes

- [#34](https://github.com/galosandoval/shopfloor/pull/34) [`938376e`](https://github.com/galosandoval/shopfloor/commit/938376ee02677673998283d26bc17688a80f2726) Thanks [@galosandoval](https://github.com/galosandoval)! - Documentation only — no API, behaviour, or configuration change.

  The README told consumers to write their own prompt template but never said
  what a template may reference. The six substituted tokens are now documented in
  a new "The prompt template" section: `{{ISSUE_NUMBER}}`, `{{ISSUE_TITLE}}`,
  `{{BRANCH}}`, `{{PR_DESCRIPTION_FILE}}`, `{{VERIFY_REPORT_FILE}}`, and
  `{{SCREENSHOTS_DIR}}`. Only the first three were guessable from the rest of the
  document; the other three are how a prompt learns where to write the artifacts
  this package reads back afterwards, so a template that omitted them produced a
  run with no PR description and nothing to post — with nothing anywhere saying
  why.

  The section also states the failure mode the substitution has always had: an
  unrecognized token renders as literal text, unchanged and unreported. There is
  no error for a misspelled placeholder, and none for one that used to exist —
  which is the position `{{STANDARDS_DIR}}` is in as of its removal.

  Also corrected: the reference-wiring link pointed at a repository name that
  404s (`galosandoval/recipe-chat-v1`, twice more in code examples — the
  repository is `galosandoval/recipe-chat`), and that reference workflow still
  clones a standards directory, so following it now yields a refused run. The
  pointer says so rather than reading as a working example.

## 0.8.0

### Minor Changes

- [#31](https://github.com/galosandoval/shopfloor/pull/31) [`b64efed`](https://github.com/galosandoval/shopfloor/commit/b64efedeb85ea9e61d69eaab87c8eee46cce8325) Thanks [@galosandoval](https://github.com/galosandoval)! - Bundle the skills plugin: installing this package now brings the skills the
  harness expects an agent to have, as a git dependency on
  [`galosandoval/skills`](https://github.com/galosandoval/skills) pinned to the
  tag `galosandoval-skills@1.1.0`. No second checkout to clone, no path to keep
  `PLUGIN_DIRS` pointed at.

  **Behavior change — an unstated `pluginDirs` no longer means "no plugins".** It
  now resolves to the bundled plugin, so a run that previously spawned with no
  `--plugin-dir` at all will spawn with one, and the agent's session carries
  skills it did not have before. A stated list **replaces** the default rather
  than adding to it; an explicitly empty list (`pluginDirs: []`, `PLUGIN_DIRS=''`)
  restores the old behavior exactly — no plugins load.

  **New failure mode — a missing bundled plugin refuses the run before spawning.**
  The bundled plugin is validated by the same check a stated one is, with no
  exemption, and the likeliest way it fails is not being on disk: a pruned
  `node_modules`, an install that skipped dependencies, or an environment that
  cannot fetch git dependencies at all. That refuses, naming
  `galosandoval-skills` and telling you to reinstall or state your own
  `pluginDirs` — rather than proceeding with none of the procedure the run was
  configured to have. The lookup goes through Node's own module resolution from
  this package's directory, so hoisted and nested layouts both answer; where it
  cannot, state `pluginDirs` explicitly.

  **New install requirement:** `git` and reachable GitHub at install time.

  **New export — `resolveBundledPluginDir()`** (and `BUNDLED_PLUGIN_PACKAGE`),
  because replacement means naming both is the only way to keep the bundled
  plugin alongside your own:

  ```ts
  import { resolveBundledPluginDir } from '@galosandoval/shopfloor'

  pluginDirs: [resolveBundledPluginDir(), '/opt/my-plugin']
  ```

  It throws `ImplementAgentError` when the dependency cannot be resolved, so CI
  glue can surface that failure without starting a run.

  The scope boundary narrows rather than reverses: **procedure ships, standards
  do not.** Skills are portable across repositories and now arrive with the
  install; opinionated coding standards remain per-repository, in the repository
  being worked on — `standardsDir` is removed in this same release, see its own
  entry.

- [#32](https://github.com/galosandoval/shopfloor/pull/32) [`55114b0`](https://github.com/galosandoval/shopfloor/commit/55114b061726854151c4ac81226249e3ddeee631) Thanks [@galosandoval](https://github.com/galosandoval)! - Remove `standardsDir`. Skills reach the agent through the Claude Code CLI's own
  plugin discovery (`pluginDirs` / `PLUGIN_DIRS`, defaulting to the bundled
  skills plugin), so a standards directory pasted into a prompt has nothing left
  to do: it was instruction-by-path, with no progressive disclosure, no way to
  load a reference only when a task called for it, and no way for the harness to
  know whether the path meant anything.

  **Breaking, in a minor — read this before bumping.**

  **What breaks.** `standardsDir` is gone from `RunImplementAgentConfig`, so a
  caller stating it no longer type-checks. The rendered prompt no longer
  substitutes `{{STANDARDS_DIR}}`.

  **What newly refuses.** A stated `standardsDir`, or a non-empty `STANDARDS_DIR`
  in the environment, **refuses the run before spawning** with an
  `ImplementAgentError` naming the replacement. This is deliberate and is the
  migration mechanism: deleting the field quietly would leave a CI-set
  `STANDARDS_DIR` meaning nothing at all — no type error, no runtime error, just
  a run proceeding with less context than its operator believes it has, which is
  the silent degradation `0.5.0`'s dead-path validation was added to stop. So a
  run that was previously green and misconfigured now fails loudly instead. An
  empty value from either source still means "deliberately skip" and does not
  refuse. There is no deprecation window where both paths work.

  **What to change.** Delete `standardsDir` from your call, unset `STANDARDS_DIR`
  in your CI, and **remove `{{STANDARDS_DIR}}` from your prompt template** — an
  unrecognized placeholder now renders as literal text, so a stale template
  leaves `{{STANDARDS_DIR}}` sitting in the prompt the agent reads. The refusal
  above means no run reaches a spawn with its configuration still wrong, but it
  cannot see your template: a caller who fixes the config and leaves the template
  stale is the one way this reaches an agent. Your coding standards belong in the
  repository being worked on — its `CLAUDE.md` and the docs it points at — where
  the agent reads them for itself.

  **What this does not close.** Of the six kinds of context a harness owes an
  agent, this moves **instructions** from delegated to shipped and **knowledge**
  from absent to partial. **Memory**, **examples**, and **tools** stay at zero —
  every run still starts cold, and a failed run still teaches the next one
  nothing. **Evals** — scoring whether a run produced good work, and whether it
  took a sound path to get there — remain the largest open gap. Native skills
  wiring closed a rotting string, not context ownership.

## 0.7.0

### Minor Changes

- [#29](https://github.com/galosandoval/shopfloor/pull/29) [`f0e52a7`](https://github.com/galosandoval/shopfloor/commit/f0e52a77cafda011d842dcc91407bde709110192) Thanks [@galosandoval](https://github.com/galosandoval)! - Add `pluginDirs` (`PLUGIN_DIRS`, comma-separated): Claude Code plugin
  directories loaded into a run for that session only, one `--plugin-dir` per
  entry, so a plugin's skills reach the agent through the CLI's own discovery
  with nothing written into your git tree.

  **New failure mode — a run now refuses before spawning** when a stated entry
  does not resolve, is not a plugin (no readable `.claude-plugin/plugin.json`),
  declares no skills while carrying no `skills/` directory, declares a skill path
  that is absent on disk, or ships **hooks or MCP servers** (from the manifest or
  from the `hooks/` and `.mcp.json` conventions). The refusal names every
  offending entry. Nothing else changes for a caller who states no plugins:
  unstated is held apart from stated-as-empty, and neither puts a flag on the
  CLI vector.

  The capability refusal is the point, not a side effect: these runs already pass
  `--dangerously-skip-permissions`, so a plugin's permission declarations are
  moot, while hooks execute without the model choosing them and MCP-contributed
  tools fall outside the command guard, which matches shell commands only. Barring
  both is what makes the promise checkable — **a stated plugin adds no automatic
  code execution and no tools outside the command guard.** Prose-only plugin
  content (skills, subagents, slash commands) is permitted.

  An entry that is a `.zip` archive is checked **for existence only** — including
  the capability check, which does not apply to it. That is a deliberately weaker
  guarantee: inspecting it would mean unpacking it. A `.zip` is the only file
  form accepted; any other file is refused, since nothing about it can be
  checked.

  `standardsDir` is unchanged.

### Patch Changes

- [#28](https://github.com/galosandoval/shopfloor/pull/28) [`3b69376`](https://github.com/galosandoval/shopfloor/commit/3b693766ec637dd472e9dc3e7284b629a320ae7a) Thanks [@galosandoval](https://github.com/galosandoval)! - Documentation only — no API, behaviour, or configuration change. The one thing
  that reaches consumers is a corrected doc comment on `src/index.ts`, which
  `tsup` emits into `dist/*.d.ts`: it claimed the package documents **two** pure
  escape hatches when there are three, and now names them (`evaluatePreflight`,
  `buildVerifyComment`, `classifyCommand`). Nothing to change on upgrade.

  The README gained what it had been silently omitting. `promptTemplate` is
  required but was missing from the resolution table, so the table read as though
  an issue number and a token were the whole contract; it is listed now, along
  with the note that it takes the template's **contents** rather than a path and
  therefore carries no environment variable. `PROMPT_FILE` is documented as what
  it actually is — the `shopfloor-implement` bin's own convenience, and the one
  variable in that document that does **not** work against `runImplementAgent`.
  The four output-file overrides (`prDescriptionFile`, `verifyReportFile`,
  `transcriptFile`, `failureReasonFile`) are in the table rather than alluded to
  in a code comment. A new section documents every `RunImplementAgentResult`
  field, including that `prDescription: 'fallback'` and
  `transcriptCaptured: false` are not failures — the run committed either way —
  so CI glue reports them instead of presenting generated prose as the agent's
  own. `CliVersionStrictness` is named among the exports.

  This repository's own coding standards also moved into the repo
  (`docs/typescript-style.md`, `docs/doc-comments.md`) from an absolute
  `~/.claude/skills/` path that exists on no CI runner and to no review
  sub-agent, with the React half split into `docs/react-style.md` and marked
  non-binding on a package that ships no React. `CONTEXT.md` records the
  standards-in-repo / procedures-in-skills boundary and the files' provenance.
  None of those documents ship: `files` remains `["dist", "CHANGELOG.md"]`, and
  consumers still point `standardsDir` at their own.

## 0.6.0

### Minor Changes

- [#21](https://github.com/galosandoval/shopfloor/pull/21) [`4d77ee3`](https://github.com/galosandoval/shopfloor/commit/4d77ee3fb3928da678b090ca9f4721fc27ab1dcd) Thanks [@galosandoval](https://github.com/galosandoval)! - add CLAUDE.md and CONTEXT.md for project documentation; establish testing conventions in docs/testing.md

## 0.5.0

### Minor Changes

- [#19](https://github.com/galosandoval/shopfloor/pull/19) [`3af079a`](https://github.com/galosandoval/shopfloor/commit/3af079a9d73671ab741043f70d5000912a46a299) Thanks [@galosandoval](https://github.com/galosandoval)! - Verify two preconditions before spawning: the CLI version and the standards path.

  **New failure mode — a misconfigured `standardsDir` now refuses the run.** A
  non-empty `standardsDir` (`STANDARDS_DIR`) that does not resolve to a directory
  fails before the Claude CLI spawns, naming the path, alongside the existing
  required-env-var check. Previously the path was substituted into the prompt
  unvalidated, so a wrong one was indistinguishable from a right one and the run
  quietly instructed the agent to read nothing — producing work against no
  standards at all. If your `standardsDir` is stale, runs that used to "pass"
  will now fail immediately; check the path before upgrading. A relative path is
  resolved against the run's `cwd`, where the agent itself reads it from. An
  empty `standardsDir` still means "deliberately skip", silently, unchanged.

  **`runPolicy.cliVersion` (`CLI_VERSION`) is now compared, not just recorded.**
  The running `claude --version` is read before the spawn and returned on the run
  result as the new `cliVersion` field, so a run's output names which CLI
  produced it even when no pin is stated. A mismatch against the pin warns by
  default and does not block; `runPolicy.cliVersionStrictness`
  (`CLI_VERSION_STRICTNESS`) takes `'warn' | 'error' | 'off'`, where `'error'`
  refuses before spawning and `'off'` skips the comparison for local dev.

  A mismatch means a differing `major.minor` — the patch is ignored, since the
  CLI surface this harness reads moves in minor releases and an exact pin would
  fail runs over changes that cannot affect it. A `claude --version` that fails
  or returns something unparseable never blocks a run at any strictness; a
  `cliVersion` that isn't a readable semver doesn't block either, but warns
  rather than disabling the check silently.

## 0.4.0

### Minor Changes

- [#17](https://github.com/galosandoval/shopfloor/pull/17) [`20850c7`](https://github.com/galosandoval/shopfloor/commit/20850c7cf7eac0fb6c27b53e50e20c86aa012381) Thanks [@galosandoval](https://github.com/galosandoval)! - Enforce the wall-clock runaway guard.

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

## 0.3.0

### Minor Changes

- [#15](https://github.com/galosandoval/shopfloor/pull/15) [`5779b3a`](https://github.com/galosandoval/shopfloor/commit/5779b3a17ddcd25f6cf336edb0ebca54dcabd736) Thanks [@galosandoval](https://github.com/galosandoval)! - Block schema pushes, force-pushes, and amends at tool-call time.

  `runImplementAgent` now arms a `PreToolUse` hook over `Bash` automatically: the
  invocation carries an inline `--settings` payload pointing at a hook script
  that ships with the package, and a forbidden command is refused with the reason
  and the sanctioned alternative fed back to the agent. The three rules —
  `prisma db push`, `git push --force` (and `--force-with-lease` /
  `--force-if-includes` / `-f` / a leading-`+` refspec), and `git commit --amend`
  — were prompt prose before, enforced only after the fact.

  A run whose hook script can't be located beside the bundle now throws
  `ImplementAgentError` instead of starting unguarded.

  Adds `classifyCommand` to the public surface as the pure decision function
  behind the hook, along with its `CommandVerdict` / `BlockedVerdict` types.
  `prepareClaudeInvocation` gains an optional `commandGuardHookPath` input. No
  configuration is required, and nothing changes for a caller that only uses the
  documented API.

## 0.2.0

### Minor Changes

- [#13](https://github.com/galosandoval/shopfloor/pull/13) [`7f6a44b`](https://github.com/galosandoval/shopfloor/commit/7f6a44b909c0122c16cce49bdcb7b21f9563c307) Thanks [@galosandoval](https://github.com/galosandoval)! - Shrink the configuration surface to an issue number, a prompt, and a token.

  A run now resolves everything else in one documented order — explicit input →
  environment variable → probe (`git`, `gh`) → package default:

  ```sh
  CLAUDE_CODE_OAUTH_TOKEN=*** PROMPT_FILE=./prompt.md npx shopfloor-implement 123
  ```

  - **`runPolicy` and every field in it are optional**, merging over the new
    exported `DEFAULT_RUN_POLICY` (150 turns, a 15-minute idle guard, no required
    env vars). With no model configured, `--model` is left off the invocation and
    the Claude CLI's own default applies.
  - **GitHub Actions values are inferred**: branch from `GITHUB_REF_NAME` (else
    the current checkout), repository from `GITHUB_REPOSITORY`, and — for
    `postVerifyComment` — the commit from `GITHUB_SHA`, the run link from
    `GITHUB_SERVER_URL`/`GITHUB_RUN_ID`, and the PR from the head branch via `gh`.
    The issue title is read from the issue itself, so the prompt can't disagree
    with what it's implementing.
  - **The four run outputs collapse into `outputDir`** (`OUTPUT_DIR`, defaulting
    to the OS temp dir), each still individually overridable. `screenshotsDir`
    stays repo-relative and issue-scoped, because those files get committed.
  - **`cliVersion` and `wallClockMinutes` are no longer required.** Neither is
    enforced by anything — the README now says so instead of advertising a
    wall-clock ceiling the harness doesn't impose. Both survive as optional
    fields so enforcement can land additively.
  - **`ANTHROPIC_API_KEY` is still stripped from the child environment
    unconditionally**, however the OAuth token was resolved.

  Breaking:

  - The public API narrows to `runImplementAgent`, `runPreflight`,
    `postVerifyComment`, `ImplementAgentError`, `evaluatePreflight`,
    `buildVerifyComment`, `DEFAULT_RUN_POLICY`, and the input/result types.
    `prepareClaudeInvocation`, `findMissingEnvVars`, `resolveIdleMs`,
    `resolveWallClockMs`, `parseClosingReferences`, `captureTranscript`,
    `findNewestSessionFile`, and the two run-policy env-var name constants are no
    longer exported — they are test seams, not API.
  - `RunImplementAgentResult` gains `branch`, the branch the run resolved to.
  - `buildVerifyComment`'s `runUrl` is optional; with none, the comment omits the
    run link rather than emitting a dead one.

  Every other change is in the lenient direction: a previously-valid
  configuration stays valid.

## 0.1.2

### Patch Changes

- [#10](https://github.com/galosandoval/shopfloor/pull/10) [`8fbd264`](https://github.com/galosandoval/shopfloor/commit/8fbd264c7ab8426e15889b9785d6aebefa485c1f) Thanks [@galosandoval](https://github.com/galosandoval)! - Added documentation for the Harness gap analysis

## 0.1.1

### Patch Changes

- [`6e6cad0`](https://github.com/galosandoval/shopfloor/commit/6e6cad0e1ec9567bff97c3220a87abda5cd1b1f2) Thanks [@galosandoval](https://github.com/galosandoval)! - Establish a Changesets release pipeline. `ci.yml` is replaced by `release.yml`,
  whose `verify` job runs lint/typecheck/test/build (plus `changeset status` on
  PRs) and whose `release` job publishes to npm via an OIDC trusted publisher
  with provenance. No package behavior changes; README gains a versioning
  section and its consumer-repo references are corrected to `recipe-chat-v1`.
