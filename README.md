# shopfloor

A typed, tested harness for a GitHub-issue-driven agent loop: spawn the
[Claude Code](https://docs.claude.com/claude-code) CLI headlessly to implement a
labeled issue as a draft PR, with runaway guards, preflight refusal, a
trajectory gate, and verify-comment posting built in.

One phase ships today — `implement` (TDD → quality gate → draft PR) — behind
**one verb**, `runPhase(rawEvent)`. Your CI keeps the checkout, the exit code,
and a setup-free admission job in front of it; the harness owns the branch, the
pull request, and the issue's labels during a run.

Why any of it is shaped this way is in [`CONTEXT.md`](./CONTEXT.md).

## Install

```sh
npm install @galosandoval/shopfloor
```

Node 20+, with `claude` and `gh` on `PATH` (this package shells out to both), and
`git` plus reachable GitHub at install time — the skills the agent runs on ship
as a bundled plugin, a git dependency on
[`galosandoval/skills`](https://github.com/galosandoval/skills) pinned to a tag.
An unstated `pluginDirs` loads it.

Coding standards are not shipped and take no path: they live in the repository
being worked on, in its `CLAUDE.md` and what that points at.

## Get set up

From an empty repository:

```sh
npx shopfloor-init     # creates labels, a workflow, and a filled prompt
npx shopfloor-doctor   # read-only: says what is still wrong
```

`init` is interactive, re-runnable, and never overwrites a file without asking.
It writes only what `doctor` says is missing, fills the prompt's environment
block from your own lockfile and scripts, and writes `TODO(shopfloor)` wherever
it cannot determine a value rather than guessing — `doctor` fails on that
sentinel, and so does a run.

Three things it leaves to you: setting the two secrets, authenticating `gh`, and
merging the scaffolded workflow to your **default branch** (a `workflow_run`
trigger fires from nowhere else). The scaffold is a starting point you then own;
nothing reads it back.

## Usage

Everything comes off the webhook payload except the token:

```ts
import { runPhase, ImplementAgentError } from '@galosandoval/shopfloor'

try {
  // With no `payload`, reads $GITHUB_EVENT_PATH — what the runner wrote to disk.
  const result = await runPhase()

  if (!result.ran) {
    console.error(`refused (${result.refusal}): ${result.reason}`)
  } else {
    console.log(
      `${result.phase} on #${result.issueNumber}: ${result.pullRequest.url}`
    )
  }
} catch (error) {
  if (error instanceof ImplementAgentError) {
    console.error(error.message, error.outputTail)
  }
  throw error
}
```

In order, `runPhase` re-checks admission → resolves the phase's prompt →
preflights → transitions the issue to `started` → locates or creates
`agent/issue-<n>` → runs the phase → pushes → locates or creates the draft PR →
posts the verify comment → transitions on the outcome.

Everything a run accepts, minus the four values the payload decides (the issue,
its title, the branch, the repository):

```ts
import { resolveBundledPluginDir } from '@galosandoval/shopfloor'
import * as fs from 'node:fs'

await runPhase({
  claudeCodeOAuthToken: process.env.CLAUDE_CODE_OAUTH_TOKEN!,
  prompts: { implement: fs.readFileSync('agent/implement/prompt.md', 'utf8') },
  maxAttempts: 3,
  // A stated list REPLACES the bundled plugin — name it to keep both.
  pluginDirs: [resolveBundledPluginDir(), '/opt/my-plugin'],
  outputDir: '/tmp/out',
  screenshotsDir: '.agent/verify/issue-123',
  projectsDir: `${process.env.HOME}/.claude/projects`,
  runPolicy: {
    // Every field optional; merges over DEFAULT_RUN_POLICY.
    maxTurns: 150,
    idleMinutes: 15,
    wallClockMinutes: 45,
    // The quality gate the HARNESS runs after each spawn. Omitted, single-shot.
    gateCommand: 'bun run typecheck && bun run test',
    maxIterations: 3,
    cliVersion: '2.1.220',
    cliVersionStrictness: 'warn',
    requiredEnvVars: ['DATABASE_URL', 'OPENAI_API_KEY', 'GH_TOKEN']
  }
})
```

### The workflow shape

Admission runs in a job of its own, with nothing installed — a spend gate behind
the spend it guards is not a gate. `runPhase` re-asks the same question anyway,
so a run reached by any other path is judged rather than assumed.

```yaml
jobs:
  admit:
    runs-on: ubuntu-latest
    outputs:
      admitted: ${{ steps.admit.outputs.admitted }}
    steps:
      # No checkout, no toolchain, no install.
      - id: admit
        env:
          GH_TOKEN: ${{ secrets.AGENT_PAT }}
        run: |
          # A refusal is a skip, not a red workflow: the verdict is read and
          # echoed either way, and the job below is gated on it.
          set +e
          verdict="$(npx --yes --package @galosandoval/shopfloor@<version> -- shopfloor-admit)"
          set -e
          echo "$verdict"
          echo "admitted=$(echo "$verdict" | jq -r '.admitted')" >> "$GITHUB_OUTPUT"

  run-phase:
    needs: admit
    if: needs.admit.outputs.admitted == 'true'
    # … checkout, install, browsers, then
    # `npx --yes --package @galosandoval/shopfloor@<version> -- shopfloor-run-phase`
```

The verdict is one line of JSON on **stdout**; the human sentence goes to stderr.

## Bins

| Bin                   | Does                                                                | Needs an install |
| --------------------- | ------------------------------------------------------------------- | ---------------- |
| `shopfloor-admit`     | Classification + spend gate + in-flight + attempt ceiling → verdict | no               |
| `shopfloor-authorize` | The spend gate alone                                                | no               |
| `shopfloor-run-phase` | Runs whatever phase the event starts — **takes no arguments**       | yes              |
| `shopfloor-doctor`    | Read-only setup report; non-zero when a check fails                 | no               |
| `shopfloor-init`      | Creates labels, workflow, prompt                                    | no               |

`shopfloor-admit` and `shopfloor-run-phase` both exit **zero** on
`not-a-trigger` — the common outcome for events the loop ignores — and non-zero
on every other refusal and every failed run. A failed run writes its reason to
`failure_reason.txt` under `OUTPUT_DIR`.

## Prompts

Prompts are keyed by phase (`prompts: { implement }`) or given as a path in
`PROMPT_FILE`. **A discovered phase with no prompt refuses at startup**, before a
token is spent.

What ships by default is a **shim, not a prompt**: it names the phase, the issue
and the branch, says where the outputs go, and defers to the skills plugin for
procedure. It carries no environment content — your install command, your gate,
your seeded database are yours, and `init` fills that block from your project.

Eight `{{PLACEHOLDER}}` tokens are substituted, and only these eight:

| Token                     | Rendered to                                                       |
| ------------------------- | ----------------------------------------------------------------- |
| `{{ISSUE_NUMBER}}`        | `issueNumber`, as resolved                                        |
| `{{ISSUE_TITLE}}`         | the issue's own title, read once via `gh`                         |
| `{{BRANCH}}`              | `agent/issue-<n>`                                                 |
| `{{PR_DESCRIPTION_FILE}}` | absolute path the agent writes its PR description to              |
| `{{VERIFY_REPORT_FILE}}`  | absolute path the agent writes its verify report to               |
| `{{SCREENSHOTS_DIR}}`     | repo-relative directory the agent commits verify screenshots to   |
| `{{ATTEMPTS_DIR}}`        | repo-relative directory holding every previous attempt's handoff  |
| `{{HANDOFF_CLAIMS_FILE}}` | absolute path the agent writes its own account of this attempt to |

An **unrecognized** token refuses the run before the spawn, naming it — as does a
prompt still carrying `init`'s `TODO(shopfloor)` sentinel. A **missing** token is
not refused; `doctor`'s `prompt-tokens` check reports it. Check your template
against this table when you upgrade.

`evaluatePromptReadiness` is the pure verdict, exported.

## Configuration

Every optional input resolves the same way: **explicit input → environment
variable → probe → package default**. Probes are lazy.

| Field                            | Environment                  | Default                                               |
| -------------------------------- | ---------------------------- | ----------------------------------------------------- |
| `claudeCodeOAuthToken`           | `CLAUDE_CODE_OAUTH_TOKEN`    | _required_                                            |
| `prompts`                        | — (path only: `PROMPT_FILE`) | the per-phase shim this package ships                 |
| `maxAttempts`                    | —                            | `3`                                                   |
| `pluginDirs`                     | `PLUGIN_DIRS` (comma-sep.)   | the bundled skills plugin; stating a list replaces it |
| `outputDir`                      | `OUTPUT_DIR`                 | OS tmpdir                                             |
| `prDescriptionFile`              | —                            | `pr_description.txt` under `outputDir`                |
| `verifyReportFile`               | —                            | `verify_report.md` under `outputDir`                  |
| `transcriptFile`                 | —                            | `transcript.jsonl` under `outputDir`                  |
| `failureReasonFile`              | —                            | `failure_reason.txt` under `outputDir`                |
| `handoffClaimsFile`              | —                            | `handoff_claims.md` under `outputDir`                 |
| `screenshotsDir`                 | `SCREENSHOTS_DIR`            | `.agent/verify/issue-<N>`                             |
| `attemptsDir`                    | `ATTEMPTS_DIR`               | `.agent/attempts`                                     |
| `projectsDir`                    | `PROJECTS_DIR`               | `~/.claude/projects`                                  |
| `runPolicy.model`                | `MODEL`                      | none — the Claude CLI's own default                   |
| `runPolicy.maxTurns`             | `MAX_TURNS`                  | `150`                                                 |
| `runPolicy.idleMinutes`          | `IDLE_MINUTES`               | `15`                                                  |
| `runPolicy.wallClockMinutes`     | `WALL_CLOCK_MINUTES`         | none — no wall-clock ceiling                          |
| `runPolicy.gateCommand`          | `GATE_COMMAND`               | none — the run is single-shot                         |
| `runPolicy.maxIterations`        | `MAX_ITERATIONS`             | `3` — reachable only with a gate stated               |
| `runPolicy.cliVersion`           | `CLI_VERSION`                | none — the running version is recorded, not compared  |
| `runPolicy.cliVersionStrictness` | `CLI_VERSION_STRICTNESS`     | `'warn'`                                              |
| `runPolicy.requiredEnvVars`      | `REQUIRED_ENV_VARS`          | `[]`                                                  |

`prompts` holds template **contents**, not paths. The four output files take no
environment variable of their own — `OUTPUT_DIR` relocates all four.
`screenshotsDir` stays repo-relative on purpose: those files get committed.

The issue, its title, the branch, and the repository are **not** configurable —
the payload decides all four, and stating one refuses the run.

`ANTHROPIC_API_KEY` is stripped from the child environment unconditionally.
`LOCAL_IDLE_MINUTES` / `LOCAL_WALL_CLOCK_MINUTES` override the guard budgets for
a single run without touching the contract.

## What a run returns

`RunPhaseResult` — either a refusal or a finished run:

| Field                 | Type                             | Meaning                                                           |
| --------------------- | -------------------------------- | ----------------------------------------------------------------- |
| `ran`                 | `boolean`                        | False for a refusal; the fields below are a finished run's        |
| `refusal` / `reason`  | `string`                         | On a refusal: admission's own kinds, or `preflight`               |
| `phase` / `edge`      | `Phase` / `'human' \| 'machine'` | Which phase ran, and which edge started it                        |
| `issueNumber`         | `number`                         | The issue the payload named                                       |
| `branch`              | `string`                         | `agent/issue-<n>`, located or created                             |
| `pullRequest`         | `{ number, url, created }`       | `created: false` when a retrigger iterated on the PR already open |
| `attempt`             | `number`                         | Which attempt this was, against `maxAttempts`                     |
| `outcome`             | `RunOutcome`                     | Always `succeeded` — every other outcome leaves by throwing       |
| `verifyCommentPosted` | `boolean`                        | Verify is best-effort and never fails a run                       |
| `run`                 | `RunImplementAgentResult`        | What the phase's own run produced                                 |

A failed run **throws** `ImplementAgentError`, after pushing whatever it
committed (best-effort; no PR is opened) and transitioning the issue.

`RunImplementAgentResult`:

| Field                | Type                    | Meaning                                                                        |
| -------------------- | ----------------------- | ------------------------------------------------------------------------------ |
| `branch`             | `string`                | The branch committed on                                                        |
| `commitsAhead`       | `number`                | Commits on `branch` since `main`                                               |
| `prDescription`      | `'agent' \| 'fallback'` | Whether the agent wrote its own PR description — `'fallback'` is not a failure |
| `transcriptCaptured` | `boolean`               | Always `true` on a result: the closure condition blocks an uncaptured run      |
| `cliVersion`         | `string \| undefined`   | The CLI version this run spawned                                               |
| `iterations`         | `number`                | How many times the run spawned the CLI                                         |
| `usage`              | `RunUsage`              | What the run spent, summed over its iterations                                 |

### What a run spent

`usage` carries `inputTokens`, `outputTokens`, `cacheCreationInputTokens`,
`cacheReadInputTokens`, an optional `costUsd`, and a `source`.

**`source` is the field to read first.** `'reported'` means every spawn reached
its terminal `result` event and these are the CLI's own numbers. `'observed'`
means at least one did not, and the totals are then this package's sum over the
`assistant` messages it watched go by — **not a total, and not uniformly a
floor**: `outputTokens` and `cacheCreationInputTokens` undercount, while
`inputTokens` and `cacheReadInputTokens` overcount, often by a large multiple,
because every turn re-sends the conversation. An `'observed'` total carries no
`costUsd`.

The numbers are always present — a stream that said nothing reports zeroes with
`source: 'observed'`, so "free" is never confused with "unmeasured". A failed run
reports its spend on `ImplementAgentError.usage`, `undefined` only when it
refused before the spawn.

## Guards and gates

**Runaway guards.** The **idle** guard (15 min default) catches a stalled agent
and is always armed, per spawn. The **wall-clock** guard catches a looping one
and is armed only when `wallClockMinutes` states a ceiling, bounding the whole
run — spawns and gates together. Either terminates the run and throws, naming
the budget, with the transcript still captured. A killed run is a hard failure
even if the agent had already committed.

**The inner loop.** State `gateCommand` and a run stops being single-shot: after
each spawn the **harness** runs that command in the run's `cwd`, and a non-zero
exit respawns with the command and a 4 KB tail of its output appended to the
prompt, up to `maxIterations`. Each iteration is a fresh spawn, not a `--resume`.
A gate still red at the ceiling **fails** the run rather than returning unvetted
work. The gate runs on the run's own environment, not the CLI's child env.
`transcriptFile` holds the last iteration; earlier ones land beside it as
`transcript.iteration-<n>.jsonl`. `evaluateIteration` is the exported rule.

**The closure condition.** A green gate is necessary and not sufficient. Every
attempt is graded over its own transcript, and two of the four trajectory
invariants gate: `gate-before-commit` and `red-before-green`. A violation with
attempts left respawns with the violated invariants appended — even with no
`gateCommand` stated. With none left, the run fails as `agent:blocked` (not
`agent:exhausted`), pushes, opens no PR, and comments naming the invariants. An
attempt with **no transcript captured** is blocked, not passed.
`evaluateClosure` and `GATING_TRAJECTORY_INVARIANTS` are exported.

**Pre-spawn preconditions.** Five things are settled just before the spawn, so a
misconfigured run costs zero tokens: `requiredEnvVars`, the prompt being filled
in, the plugin directories, the label vocabulary (`gh label list`, the one that
costs a round trip — it verifies and never creates), and the CLI version. A
removed input like `standardsDir` refuses earlier still.

**Plugin directories.** Each entry is passed as one `--plugin-dir`, loading that
plugin **for the session only**. A directory entry is refused when it does not
resolve, has no readable `.claude-plugin/plugin.json`, declares no skills and has
no `skills/`, declares a skill path absent on disk, or ships **hooks or MCP
servers** — a stated plugin adds prose, never automatic execution or tools
outside the command guard. A `.zip` is checked for existence only; remote URLs
are not accepted. The refusal names every offender. `evaluatePluginDirs` is the
pure verdict.

**CLI version.** `claude --version` is read before every spawn and returned as
`cliVersion`. With `cliVersion` pinned, a differing **`major.minor`** (the patch
is ignored) warns by default; `'error'` refuses, `'off'` skips. An unreadable
version never blocks a run.

**Command guard.** Three operations an autonomous run must never perform —
`prisma db push`, force-push, and amend — are blocked at tool-call time by a
`PreToolUse` hook the invocation arms inline, session-scoped, effective under
`--dangerously-skip-permissions`. A run refuses to start if it cannot find the
hook script; the hook itself exits 0 on anything it cannot classify.

```ts
import { classifyCommand } from '@galosandoval/shopfloor'

classifyCommand('bunx prisma migrate dev --name add_pantry') // { decision: 'allow' }
classifyCommand('git push --force origin main').decision // 'block'
```

## Triggers and admission

`classifyTrigger(rawPayload)` turns a webhook payload into a typed verdict:

```ts
const classification = classifyTrigger(JSON.parse(eventJson))
// { triggered: true, phase: 'implement', edge: 'human',
//   issueNumber: 46, actor: 'octocat', repo: 'you/your-repo' }
```

| Event                                               | Edge      | Keyed on                                                                                                   |
| --------------------------------------------------- | --------- | ---------------------------------------------------------------------------------------------------------- |
| `issues.labeled` with `ready-for-agent`             | `human`   | the **added** label, not the issue's label set                                                             |
| `workflow_run.completed` with `conclusion: failure` | `machine` | a `head_branch` of `agent/issue-<n>`, on **this** repository, from a commit authored by `claude-code[bot]` |

Everything else is `{ triggered: false, reason }` — the common case, never an
error. The machine edge additionally requires that `head_repository` match
`repository` (a fork PR carries a stranger's ref), and that the head commit not
carry the `Shopfloor-Loop: closed` trailer a finished run's strip commit does.
`agentBranchForIssue` and `issueNumberFromBranch` are exported so your glue and
this package name the same branch.

An admitted verdict carries `phase`, `edge`, `issueNumber`, `actor`, `repo`,
`branch`, `attempt`, `maxAttempts`, and `authorizedBy` —
`{ via: 'permission', permission }` on the human edge,
`{ via: 'continuation' }` on the machine edge, which is not probed because
pushing to `agent/issue-<n>` on your repository already requires write access.

A refusal carries a `reason` and one of five kinds:

| `refusal`       | Means                                                             |
| --------------- | ----------------------------------------------------------------- |
| `not-a-trigger` | Nothing happened — not an event the loop runs on (exits **zero**) |
| `not-permitted` | The actor may not spend on this repository                        |
| `undetermined`  | A probe answered nothing usable — refused, not assumed            |
| `in-flight`     | The issue is labeled `agent:in-progress`                          |
| `exhausted`     | The issue has already had its attempts                            |

Attempts are counted from how many times `agent:in-progress` was ever _added_
(the issue timeline); in-flight is whether it is on the issue now. Admission
**writes nothing** on any verdict, and refuses on uncertainty. The concurrency
check is a narrowing, not a lock — the real mutual exclusion is the
`concurrency:` group in the scaffolded workflow.

`runAdmission` is the callable and `evaluateAdmission` the pure decision:

```ts
const verdict = await runAdmission({ maxAttempts: 5 })
if (!verdict.admitted) process.exit(verdict.refusal === 'not-a-trigger' ? 0 : 1)
```

### The spend gate

On a public repository anyone who can add a label can spend your subscription, so
authorization ships as its own bin and runs before anything is installed. The
probe is
`gh api repos/{repo}/collaborators/{actor}/permission --jq '.role_name // .permission'`,
and only `admin`, `maintain`, or `write` (`SPENDING_PERMISSIONS`, exported and
fixed) may spend — a `triage` collaborator can label, and labeling is not
spending. A custom repository role is `undetermined`.

**It is the only guard here that refuses on uncertainty**: a `gh` that is
missing, unauthenticated, or rate-limited refuses rather than assuming. It writes
nothing; the exit code is the whole output. `runAuthorization` is the callable,
`evaluateAuthorization` the pure decision.

## Preflight refusal

`runPhase` refuses before spending when the issue is a PRD (it has native
sub-issues), a native sub-issue, or already has an open PR targeting it —
`{ ran: false, refusal: 'preflight', reason }`. Human edge only: asking on a
retrigger would refuse every continuation.

It is the one refusal that **writes** — it applies the `refused` transition and
comments naming `ready-for-agent` (`ENTRY_LABEL`) as the label to re-add. Because
it applies a transition it verifies the label vocabulary first and throws if any
is missing. `evaluatePreflight` is the pure decision:

```ts
evaluatePreflight({
  subIssueCount: 0,
  parentNumber: null,
  linkingPullRequests: []
})
```

## Issue state

Six labels, fixed and package-owned — the one place this package names things in
your repository:

| Label               | Means                                                        |
| ------------------- | ------------------------------------------------------------ |
| `ready-for-agent`   | Spec is ready for an agent to implement                      |
| `ready-for-human`   | The agent is done — a human owns the next move               |
| `agent:implement`   | The implement phase owns this issue                          |
| `agent:in-progress` | A run is in flight — do not start a second one on this issue |
| `agent:blocked`     | A run refused or could not proceed — a human must unblock it |
| `agent:exhausted`   | A run hit its ceiling without passing the gate               |

`shopfloor-init` creates them; `LABEL_VOCABULARY` carries each one's colour and
description, and `REQUIRED_LABELS` is just the names.

The state machine is a table, one row per outcome, exported so your glue applies
the same transition the harness does:

| Outcome     | Leaves the issue carrying              |
| ----------- | -------------------------------------- |
| `started`   | `agent:implement`, `agent:in-progress` |
| `succeeded` | `ready-for-human`                      |
| `exhausted` | `agent:exhausted`, `ready-for-human`   |
| `failed`    | `agent:blocked`, `ready-for-human`     |
| `refused`   | `agent:blocked`, `ready-for-human`     |

```ts
await applyLabelTransition({
  issueNumber: '123',
  repo: 'galosandoval/recipe-chat',
  outcome: 'succeeded'
})
```

Each row is a **target**, not a list of edits — applying the same outcome twice
writes nothing the second time, and only these six labels are ever removed. A
failed `gh` throws. `runPhase` applies every row itself; the table stays exported
for tooling that acts on a run. `evaluateLabelTransition`, `TRANSITION_TABLE`,
and `RUN_OUTCOMES` are the pure halves.

## Reporting

**Verify comment.** `runPhase` posts the agent's verify report and any committed
screenshots to the PR, pinned to the commit it just pushed. Best-effort by
contract — a failure comes back as `verifyCommentPosted: false`.
`buildVerifyComment` is the pure formatter.

**Trajectory scorecard.** Grade a finished run over its captured transcript:

```ts
const { graded, findings, scorecard } = runTrajectoryCheck({
  transcriptFile: '/tmp/out/transcript.jsonl',
  maxTurns: 150,
  scorecardFile: '/tmp/out/trajectory_scorecard.md' // optional
})
```

| Invariant              | Fails when                                                       |
| ---------------------- | ---------------------------------------------------------------- |
| `gate-before-commit`   | A `git commit` was not preceded by a whole-suite test run        |
| `red-before-green`     | No failing test run preceded the first commit                    |
| `no-forbidden-git-ops` | The run force-pushed or amended                                  |
| `turn-budget-headroom` | Turn usage reached the headroom threshold (default: ≥80% of cap) |

`runTrajectoryCheck` is advisory — it reports, never throws, and an unreadable
transcript returns `graded: false`. The gate over it is `evaluateClosure`.
`checkTrajectory` and `formatScorecard` are the pure halves. Grading uses the
default gate-command patterns plus your own `gateCommand` matched literally.

**The handoff trail.** Each attempt that does not succeed leaves
`.agent/attempts/<run-id>.md`, committed to the branch, and the next attempt
reads the whole trail through `{{ATTEMPTS_DIR}}`. Two authors, never blended:
harness-authored facts (the triggering CI failure tail and run URL, the
scorecard, the run id, the diff, what the attempt spent), written
unconditionally; and agent-authored **claims**, read back from
`{{HANDOFF_CLAIMS_FILE}}` and quoted verbatim under an unverified heading.
Every section is bounded — `HANDOFF_LOG_TAIL_LIMIT`, `HANDOFF_DIFF_LIMIT`,
`HANDOFF_CLAIMS_LIMIT` — and a truncated one says so.

The trail is **stripped on success** by the commit that also marks the loop
closed, and **kept** on failure and on the exhausted terminal state. Handoff
commits are authored as `claude-code[bot]` and skip hooks (`--no-verify`), both
load-bearing. `renderHandoff` and `DEFAULT_ATTEMPTS_DIR` are exported.

**The terminal state.** A spent ceiling gets `agent:exhausted` — never
`agent:blocked` — plus the trail as a comment; the PR stays open and the trail is
not stripped. It is written by the **admission job**, the last place the ceiling
is observed. `shopfloor-admit` does it for you; a caller driving the callables
does it themselves, once:

```ts
const verdict = await runAdmission()

if (!verdict.admitted && verdict.refusal === 'exhausted' && verdict.ceiling) {
  await reportExhaustion({ ceiling: verdict.ceiling })
}
```

## Doctor

```sh
PROMPT_FILE=./agent/implement/prompt.md npx shopfloor-doctor
```

| Check                        | Fails when                                                                              |
| ---------------------------- | --------------------------------------------------------------------------------------- |
| `gh-auth`                    | `gh` is not authenticated                                                               |
| `pat-workflow-scope`         | The token you are running as has no `workflow` scope                                    |
| `repo-secrets`               | A required secret is in neither the repository's nor the organization's secrets         |
| `label-vocabulary`           | One of the six labels does not exist                                                    |
| `cli-version-pin`            | The running `claude --version` differs from the pin on `major.minor`                    |
| `prompt-tokens`              | The prompt is missing a substituted token, or carries an unrecognized one               |
| `prompt-environment-block`   | The prompt's environment block is empty or still carries the `TODO(shopfloor)` sentinel |
| `workflow-triggers`          | The workflow is not wired to `issues.labeled` and `workflow_run.completed`              |
| `workflow-unfilled`          | The workflow still carries a scaffolded `TODO(shopfloor)` nobody replaced               |
| `workflow-run-prerequisites` | The workflow is off the default branch, or never references the PAT at all              |

Read-only and idempotent; exits non-zero when any check fails. Three statuses,
and only `✗` fails the exit code — `?` means the check could not be evaluated
(no `gh`, no `PROMPT_FILE`, no pin) and prints without failing.

**What a green doctor does not prove.** The stored PAT's scopes cannot be read,
so `pat-workflow-scope` judges the token _you_ are running as. The PAT half of
`workflow-run-prerequisites` is a reference check — "nothing uses the PAT", not
"the wrong step uses `GITHUB_TOKEN`". Environment-scoped secrets are invisible
and report as missing; state `REQUIRED_SECRETS` to name only what it can see.

| Variable            | Default                                 | What it points at                            |
| ------------------- | --------------------------------------- | -------------------------------------------- |
| `PROMPT_FILE`       | — (prompt checks report unknown)        | The prompt template to check                 |
| `WORKFLOW_FILE`     | `.github/workflows/agent-implement.yml` | The agent workflow                           |
| `REQUIRED_SECRETS`  | `CLAUDE_CODE_OAUTH_TOKEN`, `AGENT_PAT`  | Comma-separated; a stated list replaces both |
| `AGENT_PAT_SECRET`  | `AGENT_PAT`                             | Which secret holds the PAT                   |
| `CLI_VERSION`       | — (no pin, nothing to compare)          | The pin to compare `claude --version` to     |
| `GITHUB_REPOSITORY` | inferred by `gh` from the checkout      | `owner/repo`                                 |

Fence the environment block so "unfilled" is machine-checkable rather than a
judgement about prose (no fences reports unknown rather than failing):

```markdown
<!-- shopfloor:environment -->

Run the gate with `bun run typecheck && bun run test`.

<!-- /shopfloor:environment -->
```

`probeSetup()`, `evaluateSetup(facts)`, `formatSetupReport`, `PROMPT_TOKENS`, and
the environment-block constants are exported; `runInit()` and
`formatInitResult(result)` are `init`'s.

## Removed inputs

Nothing this package stops accepting is merely deleted — a type removal reaches
only a caller who typechecks, while the binding that actually breaks is CI still
exporting a variable. Every removed field, variable, result field, export, and
bin **refuses by name and says what replaced it**.

| Removed                                                                        | Refuses where                | What to do instead                                                                    |
| ------------------------------------------------------------------------------ | ---------------------------- | ------------------------------------------------------------------------------------- |
| `issueNumber` / `ISSUE_NUMBER`                                                 | `runPhase`, before admission | Nothing — the payload names the issue                                                 |
| `issueTitle` / `ISSUE_TITLE`                                                   | `runPhase`, before admission | Nothing — read from the issue once                                                    |
| `branch` / `BRANCH`                                                            | `runPhase`, before admission | Nothing — use `agentBranchForIssue` if your glue needs the name                       |
| `repo`                                                                         | `runPhase`, before admission | Nothing — the payload's repository is the run's                                       |
| `promptTemplate`                                                               | `runPhase`, before admission | `prompts: { implement }`, or `PROMPT_FILE`                                            |
| `standardsDir` / `STANDARDS_DIR`                                               | config resolution            | `pluginDirs` / `PLUGIN_DIRS`; coding standards live in the repository being worked on |
| `PermissionProbe.read`                                                         | `evaluateAuthorization`      | `answered`                                                                            |
| `permission` on an admitted verdict                                            | reading the field            | `authorizedBy`                                                                        |
| `shopfloor-implement`                                                          | the bin itself               | `shopfloor-run-phase`, which takes no arguments                                       |
| `runImplementAgent`, `runPreflight`, `postVerifyComment`, `runPluginDirsCheck` | calling the export           | `runPhase`; each shim names the pure half that still ships                            |

An **empty variable** never refuses (`ISSUE_NUMBER=` is a half-finished
deletion); an **empty field** does (`{ issueNumber: '' }` is a key someone
typed). A key carrying `undefined` never refuses. A stated field and a set
variable each refuse on their own. `GITHUB_REPOSITORY` and `GITHUB_REF_NAME` are
never refused — the runner sets both on every job.

## Exports

`src/index.ts` is the whole public surface. Beyond what the sections above name,
it also exports the constants a caller may want to compare against —
`AGENT_BRANCH_PREFIX`, `AGENT_COMMIT_AUTHOR`, `LOOP_CLOSED_TRAILER`, `PHASES`,
`DEFAULT_MAX_ATTEMPTS`, `ENTRY_LABEL`, `IN_PROGRESS_LABEL`, `EXHAUSTED_LABEL`,
`DEFAULT_GATE_COMMAND_PATTERNS`, `DEFAULT_HEADROOM_FRACTION`,
`TRAJECTORY_INVARIANT_IDS`, `EXHAUSTION_COMMENT_LIMIT` — plus
`buildExhaustionReport`, `evaluateLabelVocabulary`, and every input/result type.

The resolvers, the invocation assembler, the transcript helpers, and everything
`init` decides with are internals: import from source if you're vendoring, but
they aren't API.

## Versioning

`1.0.0`, and semver applies from here: a breaking change is a major, a minor is
additive. **Consumers should still exact-pin** — no `^`, no `~` — as the
scaffolded workflow does for both `npx` invocations and the CLI install.

`CHANGELOG.md` is authoritative for what changed in a release, including behavior
changes; the version number alone won't tell you whether a bump is safe.

## Known gap: evals

This package has **tests** — unit coverage on every pure function, no IO
mocking — and no **evals**: no scored suite over labeled trajectories, no
LM-judge check of whether a run produced a _good_ implementation. The trajectory
scorecard and the Playwright verify step are runtime signals, not an eval suite.
Named, not implied.

## License

MIT
