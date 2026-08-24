# shopfloor

A typed, tested harness for a GitHub-issue-driven SDLC agent loop: spawn the
[Claude Code](https://docs.claude.com/claude-code) CLI headlessly to
implement a labeled issue as a draft PR, with runaway guards, preflight
refusal, and verify-comment posting built in.

Per the "Agent = Model + Harness" framing — harness meaning instructions,
tools, sandboxes, orchestration logic, guardrails, and observability, not the
model itself — this package **is the harness** for the loop, not a one-off
script. It ships one phase of that loop today (`implement`: TDD → quality
gate → draft PR). Future phases — expanding an issue into a spec, and a
review loop — are intended to land as additional modules inside this same
package later, following the harness anatomy the modules are already
organized by (see [Module layout](#module-layout)).

The consumer-facing surface is **one verb**, `runPhase(rawEvent)`: it
classifies the webhook payload, re-checks admission, locates or creates the
branch and the draft PR, runs the phase, and moves the issue's labels. What
your CI still owns is the checkout, the exit code, and the setup-free
admission job in front of it. `shopfloor init` scaffolds both jobs and a prompt
skeleton; the prompt's **environment** half — your install command, your gate,
your seeded database — is still yours and is never shipped.

## Install

```sh
npm install @galosandoval/shopfloor
```

Requires Node 20+ and the `claude` and `gh` CLIs on `PATH` — this package
shells out to both rather than wrapping an SDK — plus `git` and reachable
GitHub at install time, for the bundled plugin below.

No second command, though. The skills the harness expects an agent
to have arrive with the install as the **bundled plugin** — a git dependency on
[`galosandoval/skills`](https://github.com/galosandoval/skills) pinned to a
tag — so there is no second checkout to clone and no path to keep an
environment variable pointed at. An unstated `pluginDirs` loads it; see
[Plugin directories](#pre-spawn-preconditions).

What ships in it is **procedure** — how work gets done, which is the same in
every repository. Coding standards are not procedure: they are per-repository,
so they live in the repository being worked on — in its `CLAUDE.md` and the
docs that file points at, which the agent reads for itself. This package ships
none of its own, and no longer takes a path to yours: `standardsDir` was
removed, and a run still configured for it refuses (see
[Pre-spawn preconditions](#pre-spawn-preconditions)).

From an empty repository, one command scaffolds the rest — labels, workflow,
and a prompt whose environment block it fills from your lockfile and scripts:

```sh
npx shopfloor-init
```

It is interactive, re-runnable, and never overwrites a file without asking. See
[Setup init](#setup-init), and [Setup doctor](#setup-doctor) for the read-only
half that says what is still wrong.

## Usage

A phase run needs the webhook payload and an OAuth token. Everything else — the
phase, the issue, the branch, the PR — comes off the payload or off the
convention this package owns:

```ts
import { runPhase, ImplementAgentError } from '@galosandoval/shopfloor'

try {
  // With no `payload`, it reads $GITHUB_EVENT_PATH — what the runner already
  // wrote to disk. Nothing here names an issue, a branch, or a phase.
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

**What `runPhase` does, in order.** Re-check admission (classification, the
spend gate, the in-flight check, the attempt ceiling) → resolve the phase's
prompt → preflight → transition the issue to `started` → locate or create
`agent/issue-<n>` → run the phase → push → locate or create the draft PR →
post the verify comment → transition on the outcome.

**Admission is re-checked, not assumed.** Run
[`shopfloor-admit`](#the-admission-callable) in a job of its own first, with
nothing installed: a spend gate behind the spend it guards is not a gate. This
call re-asks the same question against the same payload, so a run reached by
any other path is judged rather than admitted by assumption.

**A retrigger reuses what it finds.** The branch already exists and the PR is
already open on the machine edge, so both are located before either is created.
Branch identity is computed in exactly one place —
[`agentBranchForIssue`](#trigger-classification-and-admission) — and never
re-derived from an issue title in a `sed` pipeline.

**Refusals write nothing**, except preflight's — whose refusal _is_ a judgement
about the issue, and which labels and comments it before returning. An
admission refusal leaves the issue exactly as it found it; the in-flight case
depends on that, because the issue belongs to a run this one does not own.

Everything a run accepts is still statable, minus the four values the payload
decides (the issue, its title, the branch, the repository):

```ts
import { resolveBundledPluginDir } from '@galosandoval/shopfloor'
import * as fs from 'node:fs'

await runPhase({
  claudeCodeOAuthToken: process.env.CLAUDE_CODE_OAUTH_TOKEN!,
  // Prompts are keyed by phase. Unstated, a phase runs on the shim this
  // package ships (see below).
  prompts: { implement: fs.readFileSync('agent/implement/prompt.md', 'utf8') },
  // The outer loop's ceiling, as `shopfloor-admit --max-attempts` states it.
  maxAttempts: 3,
  // Claude Code plugins loaded for this session only, one --plugin-dir each,
  // so their skills reach the agent without anything landing in your git tree.
  // Every entry is validated before a token is spent. Stating this REPLACES
  // the bundled plugin — name it alongside yours to keep both.
  pluginDirs: [resolveBundledPluginDir(), '/opt/my-plugin'],
  // Places pr_description.txt, verify_report.md, transcript.jsonl, and
  // failure_reason.txt; each is still individually overridable.
  outputDir: '/tmp/out',
  screenshotsDir: '.agent/verify/issue-123',
  projectsDir: `${process.env.HOME}/.claude/projects`,
  runPolicy: {
    // Every field is optional and merges over DEFAULT_RUN_POLICY.
    maxTurns: 150,
    idleMinutes: 15,
    // Omitted, a run has no wall-clock ceiling — only the idle guard. This
    // bounds the whole run, iterations included, not one spawn.
    wallClockMinutes: 45,
    // The quality gate the HARNESS runs after each spawn. Omitted, a run is
    // single-shot; stated, a failure respawns with the failure fed back in.
    gateCommand: 'bun run typecheck && bun run test',
    maxIterations: 3,
    // The CLI version this policy was validated against. A mismatch on
    // major.minor warns by default; 'error' refuses the run, 'off' skips.
    cliVersion: '2.1.220',
    cliVersionStrictness: 'warn',
    // The caller's own app-specific env vars — this package bakes in none.
    requiredEnvVars: ['DATABASE_URL', 'OPENAI_API_KEY', 'GH_TOKEN']
  }
})
```

### Prompts, keyed by phase

One verb discovers the phase from the payload, so prompts are keyed by phase:
`prompts: { implement: '...' }`, or the single `PROMPT_FILE` environment
variable, which applies to whichever phase was discovered. **A discovered phase
with no prompt refuses at startup naming the phase** — before the branch,
before the transition, and before a token is spent.

**What ships by default is a shim, not a prompt.** `DEFAULT_PHASE_PROMPTS`
names the phase, names the issue and the branch, says where the run's outputs
go, and defers to the bundled skills plugin for how to carry the work out. It
carries no procedure — that lives in skills, and two copies would have no rule
for which wins — and no environment content: your install command, your gate,
your seeded database are yours, and `shopfloor init` fills that block from your
own lockfile and scripts. A run on the shim alone works; a run on your own
prompt is the normal case.

Before the spawn, a prompt's `{{PLACEHOLDER}}` tokens are rendered against the
run's own resolved values. Eight are substituted, and only these eight:

| Token                     | Rendered to                                                       |
| ------------------------- | ----------------------------------------------------------------- |
| `{{ISSUE_NUMBER}}`        | `issueNumber`, as resolved                                        |
| `{{ISSUE_TITLE}}`         | the issue's own title, read once via `gh`                         |
| `{{BRANCH}}`              | `agent/issue-<n>` — the branch the verb located or created        |
| `{{PR_DESCRIPTION_FILE}}` | absolute path the agent writes its PR description to              |
| `{{VERIFY_REPORT_FILE}}`  | absolute path the agent writes its verify report to               |
| `{{SCREENSHOTS_DIR}}`     | repo-relative directory the agent commits verify screenshots to   |
| `{{ATTEMPTS_DIR}}`        | repo-relative directory holding every previous attempt's handoff  |
| `{{HANDOFF_CLAIMS_FILE}}` | absolute path the agent writes its own account of this attempt to |

The output paths are how a prompt tells the agent where to put the artifacts
this package then reads back — a template that never names them yields a run
with no PR description (`prDescription: 'fallback'`) and nothing to post.

`{{ATTEMPTS_DIR}}` is a **path**, not the trail itself: inlining N previous
attempts would cost context linearly in attempt count and put the whole trail
in static context. See [The handoff trail](#the-handoff-trail).

**An unrecognized token refuses the run**, before the spawn and before any
probe — a misspelled placeholder, or one that used to exist, like
`{{STANDARDS_DIR}}`. It used to render as literal text, unchanged and
unreported, which made an unfilled placeholder indistinguishable from prose; a
prompt that carried one now fails immediately, naming it and this table. So does
one still carrying `shopfloor init`'s `TODO(shopfloor)` sentinel. See [Pre-spawn
preconditions](#pre-spawn-preconditions).

A **missing** token is not refused — leaving one out is a choice this package
does not second-guess, and `shopfloor-doctor`'s `prompt-tokens` check is where
it is reported. Check your template against this table when you upgrade.

### What a run returns

`runPhase` answers with `RunPhaseResult` — either a refusal or a finished run:

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
| `run`                 | `RunImplementAgentResult`        | What the phase's own run produced, below                          |

A failed run **throws** `ImplementAgentError` — and first pushes whatever it
committed (best-effort, so the work outlives the runner; no PR is opened for
it) and transitions the issue: `exhausted` when the inner loop spent its ceiling with the gate still
red, `failed` otherwise. Both terminal rows set `ready-for-human`, so no way
out of a started run leaves an issue sitting in `agent:in-progress`.

The phase's own run answers with `RunImplementAgentResult`:

| Field                | Type                    | Meaning                                                                                                         |
| -------------------- | ----------------------- | --------------------------------------------------------------------------------------------------------------- |
| `branch`             | `string`                | The branch committed on, as resolved — stated, inferred, or probed                                              |
| `commitsAhead`       | `number`                | Commits on `branch` since `main`, per `git rev-list --count`                                                    |
| `prDescription`      | `'agent' \| 'fallback'` | Whether the agent wrote its own PR description, or this run supplied one                                        |
| `transcriptCaptured` | `boolean`               | Whether the session transcript was found and copied to `transcriptFile`                                         |
| `cliVersion`         | `string \| undefined`   | The CLI version this run spawned; undefined when that probe failed or was unreadable                            |
| `iterations`         | `number`                | How many times the run spawned the CLI — `1` without a `gateCommand`, unless the trajectory sent it round again |
| `usage`              | `RunUsage`              | What the run spent, summed over its iterations — see below                                                      |

`prDescription: 'fallback'` is **not** a failure — the run committed either
way. It is there so CI glue can say so in the PR rather than presenting
generated prose as the agent's own.

`transcriptCaptured` used to be the same kind of report, and is not any more:
the [closure condition](#the-closure-condition) blocks a run whose last attempt
was not captured, so it is always `true` on a result. It stays on the type
because a caller reading it as "there is a transcript to upload" still gets the
right answer.

#### What a run spent

The CLI's `stream-json` output already flows through the harness process — the
idle guard reads it as a heartbeat — and `usage` is that stream parsed as it
arrives rather than dropped. It exists because the inner loop bounds a run by
_attempts_, and attempts are not the budget the loop multiplies.

| Field                      | Type                       | Meaning                                                     |
| -------------------------- | -------------------------- | ----------------------------------------------------------- |
| `inputTokens`              | `number`                   | Uncached input tokens                                       |
| `outputTokens`             | `number`                   | Output tokens                                               |
| `cacheCreationInputTokens` | `number`                   | Tokens written to the prompt cache                          |
| `cacheReadInputTokens`     | `number`                   | Tokens served from it                                       |
| `costUsd`                  | `number \| undefined`      | USD, when the stream reported it                            |
| `source`                   | `'reported' \| 'observed'` | Whether these are the CLI's own tally or this package's sum |

**`source` is the field to read first.** `'reported'` means every spawn reached
its terminal `result` event and these are the CLI's own numbers. `'observed'`
means at least one did not — a run a guard killed, or one whose stream was
unreadable — and the totals are then this package's sum over the `assistant`
messages it watched go by, each counted at the snapshot taken when its message
started.

**An `'observed'` total is not a total, and it is not uniformly a floor
either** — the buckets degrade in opposite directions:

- `outputTokens` and `cacheCreationInputTokens` **undercount**. The snapshot
  precedes the message's final count, and a run killed mid-message contributes
  nothing at all. Read them as a lower bound.
- `inputTokens` and `cacheReadInputTokens` **overcount**, usually by a lot.
  Every turn re-sends the conversation, so each message restates the prefix its
  predecessors already reported; summing across N turns counts the same tokens
  up to N times. On a multi-turn run these can exceed the CLI's own tally by a
  large multiple. Read them as evidence that work happened, not as a quantity.

A `'observed'` total carries no `costUsd` even where one was seen: a cost is a
whole session's, and pairing a complete price with an incomplete token count is
the misreading `source` exists to prevent.

The numbers are always present. A run whose stream said nothing about usage
reports zeroes with `source: 'observed'`, so "free" is never confused with
"unmeasured". Nothing about this fails a run: an unreadable diagnostic must not
cause an outage, so a malformed line is skipped and the run continues.

**A failed run reports its spend too**, on the error rather than on a result it
never produces — `ImplementAgentError.usage`. A guard kill, a non-zero CLI
exit, an exhausted attempt ceiling, and a run that committed nothing all spent
real tokens, and those are the runs whose cost is least visible. It is
`undefined` only for a failure that refused before the spawn, where the answer
is genuinely nothing.

That number is also what every failed attempt's handoff states, so the trail a
spent ceiling posts says what the loop cost as well as what it tried — see
[the handoff trail](#the-handoff-trail).

### Resolution order

Every optional input resolves the same way: **explicit input → environment
variable → probe (`git`, `gh`) → package default**. Probes are lazy — a field
you state, or one the environment already carries, never spawns a subprocess.

| Field                            | Environment                 | Probe           | Default                                               |
| -------------------------------- | --------------------------- | --------------- | ----------------------------------------------------- |
| `issueNumber`                    | `ISSUE_NUMBER`              | —               | _required_                                            |
| `claudeCodeOAuthToken`           | `CLAUDE_CODE_OAUTH_TOKEN`   | —               | _required_                                            |
| `promptTemplate`                 | — (CLI only: `PROMPT_FILE`) | —               | _required_                                            |
| `issueTitle`                     | `ISSUE_TITLE`               | `gh issue view` | —                                                     |
| `branch`                         | `BRANCH`, `GITHUB_REF_NAME` | `git rev-parse` | —                                                     |
| `repo`                           | `GITHUB_REPOSITORY`         | —               | unset; `gh` then infers it from the checkout          |
| `pluginDirs`                     | `PLUGIN_DIRS` (comma-sep.)  | —               | the bundled skills plugin; stating a list replaces it |
| `outputDir`                      | `OUTPUT_DIR`                | —               | OS tmpdir                                             |
| `prDescriptionFile`              | —                           | —               | `pr_description.txt` under `outputDir`                |
| `verifyReportFile`               | —                           | —               | `verify_report.md` under `outputDir`                  |
| `transcriptFile`                 | —                           | —               | `transcript.jsonl` under `outputDir`                  |
| `failureReasonFile`              | —                           | —               | `failure_reason.txt` under `outputDir`                |
| `screenshotsDir`                 | `SCREENSHOTS_DIR`           | —               | `.agent/verify/issue-<N>`                             |
| `attemptsDir`                    | `ATTEMPTS_DIR`              | —               | `.agent/attempts`                                     |
| `handoffClaimsFile`              | —                           | —               | `handoff_claims.md` under `outputDir`                 |
| `projectsDir`                    | `PROJECTS_DIR`              | —               | `~/.claude/projects`                                  |
| `runPolicy.model`                | `MODEL`                     | —               | none — the Claude CLI's own default                   |
| `runPolicy.maxTurns`             | `MAX_TURNS`                 | —               | `150`                                                 |
| `runPolicy.idleMinutes`          | `IDLE_MINUTES`              | —               | `15`                                                  |
| `runPolicy.wallClockMinutes`     | `WALL_CLOCK_MINUTES`        | —               | none — the run has no wall-clock ceiling              |
| `runPolicy.gateCommand`          | `GATE_COMMAND`              | —               | none — the run is single-shot                         |
| `runPolicy.maxIterations`        | `MAX_ITERATIONS`            | —               | `3` — reachable only with a gate stated               |
| `runPolicy.cliVersion`           | `CLI_VERSION`               | —               | none — the running version is recorded, not compared  |
| `runPolicy.cliVersionStrictness` | `CLI_VERSION_STRICTNESS`    | —               | `'warn'`                                              |
| `runPolicy.requiredEnvVars`      | `REQUIRED_ENV_VARS`         | —               | `[]`                                                  |

`prompts` holds raw template **contents** keyed by phase, not paths.
`PROMPT_FILE` is the one variable read off disk: `runPhase` reads that path and
applies it to whichever phase the payload discovered.

The four output files take no environment variable either: state one to move it,
or leave it and it lands under `outputDir`. That is where `OUTPUT_DIR` earns its
place — one variable relocates all four.

`screenshotsDir` is deliberately **not** derived from `outputDir`: those files
get committed, so they stay repo-relative while the rest of the run's outputs
live in a temp dir.

`ANTHROPIC_API_KEY` is stripped from the child environment unconditionally,
however the OAuth token was resolved — inference never widens the auth surface.

`LOCAL_IDLE_MINUTES` / `LOCAL_WALL_CLOCK_MINUTES` override the guard budgets
for a single run without touching the contract.

#### Runaway guards

Two time-based guards watch a run, because they catch different failures. The
**idle guard** catches a _stalled_ agent — output goes silent — and is always
armed, at 15 minutes by default. The **wall-clock guard** catches a _looping_
agent, one that stays productive-looking and resets the idle timer on every
chunk; it is armed only when `runPolicy.wallClockMinutes` (`WALL_CLOCK_MINUTES`)
states a ceiling, since a default ceiling would kill runs no caller asked to
bound.

Either guard terminates the run and throws an `ImplementAgentError` naming the
budget that tripped, with the transcript still captured. How they kill differs
on purpose: the wall-clock guard sends `SIGTERM`, waits 30 seconds, then
`SIGKILL`s, giving a looping agent a chance to flush real uncommitted work,
while the idle guard goes straight to `SIGKILL` — a stalled agent is usually
wedged somewhere that cannot service a signal handler anyway.

**A killed run is a hard failure even if the agent had already committed.** It
never reached its own verify phase, so those commits are unvetted
work-in-progress. That is deliberately stricter than the missing-PR-description
case below, where the commits were finished and only the prose was absent. A
kill ends the run outright; it never becomes another iteration.

**The two guards bound different things**, and the difference only shows up on
a run that iterates. The **idle budget is per spawn** — it measures one live
process going quiet, and there is no such thing as a process that fell silent
between spawns. The **wall-clock budget is per run**: each spawn is armed with
what is left of it, and a run with none left fails rather than starting another.
A single-iteration run is armed exactly as it was before the inner loop existed.

#### The inner loop

State a `runPolicy.gateCommand` (`GATE_COMMAND`) and a run stops being
single-shot. After each spawn the **harness** runs that command in the run's
`cwd`; a non-zero exit spawns the CLI again with the command and a 4 KB tail of
its output appended to the prompt, up to `runPolicy.maxIterations`
(`MAX_ITERATIONS`, default `3`). Omit the gate and nothing changes: one spawn,
as before.

Three things about it are worth stating plainly, because each was a decision:

- **The harness generates the signal, not the agent.** The gate is a command
  this package runs and observes the exit status of. An agent's own report that
  its gate passed is not a signal — a fluent run that skipped verification is
  exactly what the loop exists to catch. The command is yours: this package
  ships no build-tool vocabulary, on the same footing as `requiredEnvVars`. It
  runs through a shell, so a chain (`&&`) works, and it is trusted input from
  your configuration — never from the issue, the agent, or anything the run
  read.
- **Each iteration is a fresh spawn, not a `--resume`.** Resuming would keep the
  reasoning that produced the failing work in the context of the turn meant to
  correct it. The cost is named rather than hidden: every iteration pays for its
  static context again.
- **A spent budget fails the run.** A gate still red at `maxIterations`, or a
  run with too little wall clock left to be worth another attempt (under a
  minute), throws an `ImplementAgentError` naming the gate and the budget. It
  does not return unvetted work as a success. Stopping a little above zero is
  deliberate: a spawn given seconds would be killed by the wall-clock guard, and
  the run would then report a runaway agent instead of the spent budget it is.

Two details worth knowing before you wire this up:

- **The gate's own runtime is charged to the wall clock.** A gate is normally
  the whole test suite, and time the run spends inside it is time the run spent.
  `wallClockMinutes` therefore bounds spawns _and_ gates together.
- **The gate runs on the run's own environment, not the CLI's child env.** No
  OAuth token is injected into it, and `ANTHROPIC_API_KEY` is not stripped from
  it — that pair exists to keep the _agent_ off a metered key, and your test
  suite is not the agent. Your `requiredEnvVars` are there as usual.
- **`transcriptFile` holds the last iteration's transcript, and the failed
  attempts land beside it.** Each pass overwrites `transcriptFile`, so before
  iterating the attempt that just failed is kept at
  `transcript.iteration-<n>.jsonl` in the same directory. `runTrajectoryCheck`
  still grades `transcriptFile` — the session that finished the run — and you
  can point it at an earlier attempt to grade that one instead. A single-shot
  run writes no `iteration-` files at all.

`evaluateIteration` — the pure function that decides iterate / done /
exhausted — is exported, so the rule can be tested or reused without a run.

#### Pre-spawn preconditions

Five things are settled just before the CLI spawns, so a misconfigured run
costs zero tokens: the `runPolicy.requiredEnvVars` check, the prompt being
filled in, the plugin directories, the label vocabulary, and the CLI version. A
sixth refuses earlier still, while the configuration resolves, because it needs
nothing from disk to detect: a standards directory.

**A standards directory — fails the run.** `standardsDir` is gone, and the
prompt no longer carries a `{{STANDARDS_DIR}}` placeholder to substitute into;
skills reach the agent through the CLI's own plugin discovery instead. A run
that still states `standardsDir`, or whose environment still sets a non-empty
`STANDARDS_DIR`, **refuses before spawning** and names the replacement. That
refusal is the migration: dropping the field quietly would leave a CI-set
variable meaning nothing at all — no type error, no runtime error, just a run
with less context than its operator believes it has. An empty value from either
source still means "deliberately skip" and does not refuse, exactly as before.

A prompt template that still contains `{{STANDARDS_DIR}}` is refused by the next
check rather than rendered — see below.

**An unfilled prompt — fails the run.** Before any probe runs, the prompt is
checked for the two things that mean it was never finished: `shopfloor init`'s
`TODO(shopfloor)` sentinel, and a `{{TOKEN}}` outside [the ones this package
substitutes](#the-prompt-template). Either **refuses before spawning**, naming
every offender — the sentinel by line number, an unknown token beside the table
of real ones.

Both used to be invisible. A sentinel was a `TODO` in prose, and an unrecognized
token rendered as literal text, so a consumer who skipped filling the
environment block paid for a full run that then failed on a command their
repository does not have. **This is a new failure mode for an existing prompt:**
a template carrying either now refuses where it previously ran.

`npx shopfloor-doctor` reports most of this without spending anything, and
`evaluatePromptReadiness` is exported for tooling that wants the verdict on its
own. The doctor and the run are **not the same check**, and the run is the
stricter of the two: the doctor looks for the sentinel only inside the
environment fences and reads tokens as upper-case with surrounding spaces
tolerated, while the run refuses on the sentinel anywhere in the prompt and on
any identifier-shaped `{{ token }}` the renderer would not substitute —
`{{ ISSUE_NUMBER }}` and `{{issue_number}}` included, because those reach the
agent as literal text exactly like a misspelling does. Braced prose that is not
identifier-shaped is left alone.

A _missing_ token is deliberately not refused here — see [the prompt
template](#the-prompt-template).

**Plugin directories — fail the run.** Each entry in `pluginDirs`
(`PLUGIN_DIRS`, comma-separated) is passed to the CLI as `--plugin-dir`, one
flag occurrence per entry, loading that plugin **for the session only** — the
CLI's own skill discovery, with nothing written into your git tree. That last
part matters: the agent commits its own work, and files it did not create risk
being swept into a commit. A relative entry resolves against the run's `cwd`,
which is where the CLI resolves it from. Remote plugin URLs are deliberately
not accepted — fetching unattested code over the network into a
fully-permissioned autonomous run is its own decision, not a free ride on this
one.

**Unstated, the list is the bundled plugin.** Installing this package brings
[`galosandoval/skills`](https://github.com/galosandoval/skills) with it as a git
dependency pinned to a tag, and an unstated `pluginDirs` loads that. Its
resolved location is on the public surface as `resolveBundledPluginDir()`,
because a **stated list replaces the default rather than adding to it** — so
naming both is something you write, not something you guess:

```ts
import { resolveBundledPluginDir } from '@galosandoval/shopfloor'

pluginDirs: [resolveBundledPluginDir(), '/opt/my-plugin']
```

Replacement, not addition: a default that always loads is a floor rather than a
default, and a floor is what turns a harness into a framework — your own version
of a bundled skill would load beside it, with the CLI arbitrating a collision
this package created. It also keeps the opt-out free: an explicitly empty list
(`pluginDirs: []`, `PLUGIN_DIRS=''`) loads no plugins at all, which is why an
unstated list and an empty one are held apart rather than collapsed.

The bundled plugin is validated exactly like a stated one — no exemption. Its
likeliest failure is not being on disk at all (a strict package-manager layout,
a pruned install), and that refuses the run naming the package, rather than
letting it proceed with none of the procedure it was configured to have.

Nothing spawns until every entry passes. A **directory** entry is refused when:

| Refused when                                                          | Why                                                                                                                                   |
| --------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| it does not resolve                                                   | the failure a bare standards path used to hide — a rotted path and a correct one are indistinguishable once the flag is on the vector |
| it has no readable `.claude-plugin/plugin.json`                       | it is not a plugin                                                                                                                    |
| its manifest declares no skills **and** it has no `skills/` directory | it contributes nothing the run asked for                                                                                              |
| its manifest declares a skill path that is absent on disk             | the manifest is stale                                                                                                                 |
| it ships **hooks** or **MCP servers**                                 | see below                                                                                                                             |

The refusal names every offending entry and what is wrong with it, not just the
first.

The check asserts what the manifest asserts about itself, and **no more** — it
does not count skill files or read their frontmatter. Anything deeper would be
a second, independent model of how the CLI discovers skills, and it would drift
from the real one.

An entry that is an **archive** — a `.zip`, the only file form accepted; any
other file is refused — is checked **for existence only**. That is a deliberately weaker guarantee: inspecting it
would mean unpacking it, which reintroduces exactly the staging work passing a
directory to the CLI avoids. Nothing below applies to an archive — including
the capability refusal.

**Hooks and MCP servers — refused.** Both are refused whether declared in the
manifest (`hooks`, `mcpServers`) or present only as convention (`hooks/`,
`.mcp.json`); published plugins commonly declare neither key and rely on the
directory names alone, so both are checked.

The reason is specific to how these runs execute. They already pass
`--dangerously-skip-permissions`, so a plugin's tool-permission declarations
are moot — nothing is gated either way. What is _not_ moot is code that runs
automatically without the model choosing to invoke it, and tools that fall
outside the [command guard](#command-guard), which matches shell commands only
and therefore cannot see a tool contributed by an MCP server. That is what
makes this promise mean something: **a stated plugin adds no automatic code
execution and no tools outside the command guard.** Plugin content that is only
prose — skills, subagent definitions, slash commands — is deliberately
permitted; a headless run never even invokes a slash command.

**The label vocabulary — fails the run.** `gh label list` is read against the
run's repository, and a repository missing any of [the six labels this package
owns](#issue-state-and-the-label-vocabulary) **refuses before spawning**,
naming every one that is absent. It is the only precondition that costs a
network round trip, so it runs after every local check has had its chance to
refuse for free.

**It verifies; it never creates.** Creating labels is a durable write to a
shared human workspace, so it belongs to `npx shopfloor-init`, at a moment you
asked for it — not to a run that happened to be triggered. Verification is what
makes the failure below impossible; creation never was.

**This is a new failure mode for an existing setup:** a repository lacking a
label used to have its transition silently skipped, and now fails the run
instead. That is the point. In the live consumer, a workflow step swapping
`ready-for-agent` for `ready-for-human` had failed on _every_ successful run
since it was written — the label did not exist, and `|| true` swallowed it. A
transition the pipeline claimed to make had never once happened. Run
`npx shopfloor-doctor` to see the gap, `npx shopfloor-init` to close it.

An **unreadable** label list refuses too, and says so rather than naming
labels — `gh` unauthenticated and a repository unconfigured are different
things to go fix. That is stricter than the doctor, which reports the same fact
as `unknown` and passes: a diagnostic tolerates its own blind spots, a gate on
spend does not. Refusing costs one re-run before a token is spent; proceeding
buys a whole run whose closing transition then fails against a repository
nobody checked.

**CLI version — warns by default.** The running `claude --version` is read
before the spawn and returned on the run result as `cliVersion`, so a run's
output always names which CLI produced it. When `runPolicy.cliVersion`
(`CLI_VERSION`) states a pin, the two are compared:

| `runPolicy.cliVersionStrictness` | `CLI_VERSION_STRICTNESS` | On mismatch                      |
| -------------------------------- | ------------------------ | -------------------------------- |
| `'warn'` _(default)_             | `warn`                   | Logs a warning; the run proceeds |
| `'error'`                        | `error`                  | Refuses before spawning          |
| `'off'`                          | `off`                    | No comparison at all             |

**A mismatch means a differing `major.minor` — the patch is ignored.** The
surfaces this harness depends on are CLI features (the headless flag vector,
the stream-json event shape, the `~/.claude/projects` session layout), and
features arrive in minor releases; a patch bump fixes surface that already
exists. Requiring an exact match would fail runs over changes that cannot
affect the harness — the pin churn that trains people to delete the check.
The rule is the same at every strictness; only the consequence differs.

Absent `cliVersion`, the version is recorded and compared to nothing. A
`claude --version` that fails or returns something unrecognizable never blocks
a run, whatever the strictness — an unreadable version is the harness's own
uncertainty, and refusing a run over it would turn a missing diagnostic into an
outage. A stated `cliVersion` that isn't a readable semver doesn't block either,
but it does warn: a check that silently stopped running is the exact rot this
is here to catch.

### CLI

A thin bin entrypoint runs whatever phase the event starts, for a drop-in CI
step:

```sh
CLAUDE_CODE_OAUTH_TOKEN=*** GH_TOKEN=*** PROMPT_FILE=./prompt.md npx shopfloor-run-phase
```

**It takes no arguments.** The issue, the phase, and the actor come off
`$GITHUB_EVENT_PATH`, and the branch is the harness's own — a step that states
nothing cannot state it wrong. Every environment variable in the table above
still works; the resolution lives in the harness, not in this entrypoint.

Its exit code splits the way `shopfloor-admit`'s does: `not-a-trigger` exits
zero, because it is the outcome for the large majority of events that reach the
loop and painting the repository red for those is how a check gets deleted.
Every other refusal, and every failed run, exits non-zero. A failed run writes
its reason to `failure_reason.txt` under `OUTPUT_DIR`.

### Trigger classification and admission

Which webhook event starts which phase, on whose behalf, and whether it may
start at all. Pass the **raw webhook payload** — the contents of
`$GITHUB_EVENT_PATH`, undestructured — and the answer is a typed verdict rather
than a stack of `if:` expressions:

```ts
import { classifyTrigger } from '@galosandoval/shopfloor'

const classification = classifyTrigger(JSON.parse(eventJson))
// { triggered: true, phase: 'implement', edge: 'human',
//   issueNumber: 46, actor: 'octocat', repo: 'you/your-repo' }
```

Two edges are admitted:

| Event                                               | Edge      | Keyed on                                                                                                   |
| --------------------------------------------------- | --------- | ---------------------------------------------------------------------------------------------------------- |
| `issues.labeled` with `ready-for-agent`             | `human`   | the **added** label, not the issue's label set                                                             |
| `workflow_run.completed` with `conclusion: failure` | `machine` | a `head_branch` of `agent/issue-<n>`, on **this** repository, from a commit authored by `claude-code[bot]` |

Everything else — a different label, a green CI run, a branch the harness does
not own, a payload that will not parse — is `{ triggered: false, reason }`. That
is the common case, not an error: every label anyone adds to any issue reaches
this function, and it never throws on one.

The human edge is keyed on the _added_ label deliberately. The harness adds
labels of its own (`agent:in-progress` when a run starts), and each of those
fires `issues.labeled` again — a trigger reading the issue's label set instead
of the addition would restart itself. The phase comes from an `agent:<phase>`
label on the issue, falling back to `implement`, the only phase that ships.

The machine edge reads the issue number out of the branch, which is the only
place a finished CI run says which issue it belongs to. `agentBranchForIssue`
and `issueNumberFromBranch` are exported, because your glue and this package
have to name the same branch and two conventions that agree by eye are the
binding this design exists to eliminate.

**The branch name is a pre-filter, not the test.** Two more fences decide the
machine edge, and both are load-bearing rather than tidy:

- `head_repository.full_name` must equal `repository.full_name`. A
  `workflow_run` from a fork PR carries the fork's ref with **your** repository
  in `repository`, so a stranger picks the branch name there. A head repository
  the payload does not state refuses the same way a mismatched one does.
- The head commit must be authored by `claude-code[bot]`
  (`AGENT_COMMIT_AUTHOR`, matched against the commit's `name` or the local part
  of its `email`). Your own commit onto the agent's branch is CI red the loop
  must not answer — you are already at the keyboard. The author is fixed, not
  configurable, for the reason the label vocabulary is: a consumer naming their
  own identity here turns every push they make into a retrigger.
- The head commit must not be this package's own **loop-closing** commit. The
  strip that ends a successful run is authored as the agent like the work under
  it, and it carries a `Shopfloor-Loop: closed` trailer (`LOOP_CLOSED_TRAILER`,
  exported) on its own line. The asymmetry is the loop: a failed attempt's
  handoff commit **must** retrigger, since that is how the loop iterates, while
  a finished run's must not — that branch has an open pull request and a human
  on it, and answering CI red there would spend an attempt on work nobody asked
  the agent to keep, starting cold, since the strip is what removed the trail.

#### The admission callable

Classification, authorization, the concurrency check, and the attempt ceiling,
composed into one verdict — and shipped as its own bin so a job with **nothing
installed** runs it first:

```yaml
jobs:
  admit:
    runs-on: ubuntu-latest
    outputs:
      verdict: ${{ steps.admit.outputs.verdict }}
    steps:
      # No checkout, no toolchain, no install. GITHUB_EVENT_PATH comes from
      # the runner.
      - id: admit
        env:
          GH_TOKEN: ${{ secrets.AGENT_PAT }}
        # The assignment runs first and on its own, so a non-zero refusal fails
        # this step under the default `bash -e`. Writing the output inside the
        # `echo` instead would make the step's status `echo`'s, swallowing every
        # refusal the exit code is there to carry.
        run: |
          verdict="$(npx -y @galosandoval/shopfloor@<version> shopfloor-admit)"
          echo "verdict=$verdict" >> "$GITHUB_OUTPUT"

  implement:
    needs: admit
    if: fromJSON(needs.admit.outputs.verdict).admitted
    # … the expensive job: checkout, install, browsers, the run itself
```

The verdict is one line of JSON on **stdout**; the human sentence goes to
stderr, so stdout stays machine-readable with no flag deciding which mode the
command is in. `--max-attempts <n>` raises the ceiling.

An admitted verdict carries what the run needs — `phase`, `edge`,
`issueNumber`, `actor`, `repo`, `branch`, `attempt`, `maxAttempts`, and
`authorizedBy`, which says which of the two authorities let it through:

| `authorizedBy`                           | Edge      | Means                                                             |
| ---------------------------------------- | --------- | ----------------------------------------------------------------- |
| `{ via: 'permission', permission: '…' }` | `human`   | A person triggered it, and the spend gate probed what they may do |
| `{ via: 'continuation' }`                | `machine` | Nobody triggered it — the loop's own failed run did               |

**The machine edge is not probed, and that is the correction rather than a
shortcut.** There is no login on it worth asking about: `triggering_actor` is
whatever credential pushed, frequently `github-actions[bot]`, whose collaborator
permission is `none` — so probing it refused the one edge with no human on it,
every time. What authorizes a continuation is that pushing to `agent/issue-<n>`
**on your repository** already requires write access, which is a spending
permission. The fork fence above is what keeps that sentence true, which is why
it refuses on an unstated head repository too.

A refusal carries a `reason` and one of five kinds:

| `refusal`       | Means                                                                                  |
| --------------- | -------------------------------------------------------------------------------------- |
| `not-a-trigger` | Nothing happened — not an event the loop runs on                                       |
| `not-permitted` | The actor may not spend on this repository                                             |
| `undetermined`  | A probe answered nothing usable — refused, not assumed                                 |
| `in-flight`     | The issue is labeled `agent:in-progress` — a run is already going                      |
| `exhausted`     | The issue has already had its attempts — see [the terminal state](#the-terminal-state) |

**The exit code splits, and the split is deliberate.** `not-a-trigger` exits
zero: it is by far the most common outcome, and painting the repository red for
events where nothing happened is how a check gets deleted. Every other refusal
exits non-zero, so a caller who ignores stdout is still stopped by a stranger,
a broken token, a run in flight, or a spent ceiling.

**It runs the probes in the order that costs least, and skips what it does not
need.** An event that classifies as nothing spends no subprocess at all; an
actor who may not spend never costs a run-list call; and the machine edge never
runs the permission probe, because there is no login on it to ask about.

**It writes nothing**, on any verdict — the same rule the spend gate follows,
and for the same reason: a refusal that labelled or commented would hand any
drive-by triager a way to make the harness write to your repository. The
`shopfloor-admit` **bin** makes exactly one write, on the `exhausted` verdict;
see [the terminal state](#the-terminal-state) below.

**It refuses on uncertainty**, like the spend gate it wraps and unlike every
other guard here. An unreadable issue is not "probably no attempts" — it is not
knowing whether a run is already spending on this issue, or whether the ceiling
is already spent.

**Both counts are read off the issue, and nothing extra is written to get
them.** The `started` transition already adds `agent:in-progress`, and GitHub's
issue timeline keeps every `labeled` event permanently — after the label is
removed, and after any `always()` clear. So:

- **attempts** = how many times `agent:in-progress` was ever _added_
  (`gh api repos/…/issues/<n>/timeline`), which counts runs that started,
  including ones killed before they could clean up;
- **in flight** = whether `agent:in-progress` is on the issue _now_
  (`gh issue view <n> --json labels`).

This reverses design §4 and §7, which derived both from `gh run list --branch`.
That mechanism cannot work: a run triggered by `issues.labeled` — or by
`workflow_run` — executes on the **default branch**, so its `head_branch` is
`main` and a list filtered by `agent/issue-<n>` is empty on every real run.
Derive-don't-store was argued against an alternative that never fires.

**The concurrency check is a narrowing, not a lock.** §7 rejected the label as
a _lock_, and that stands: a maintainer clearing a stuck `agent:in-progress`
silently unlocks concurrent spending, and two events landing together can both
read it absent. The real mutual exclusion is a `concurrency:` group in your
workflow — the one `shopfloor init` scaffolds already has it. What this adds is
a cheap check in front of it, on a signal that exists.

For a caller that wants the verdict rather than a process, `runAdmission` is the
callable and `evaluateAdmission` is the pure decision underneath, over facts you
gathered yourself:

```ts
import { runAdmission } from '@galosandoval/shopfloor'

const verdict = await runAdmission({ maxAttempts: 5 })
if (!verdict.admitted) process.exit(verdict.refusal === 'not-a-trigger' ? 0 : 1)
```

Its job is to gate the expensive one from a job that installed nothing.
`runPhase` re-asks the same question itself rather than trusting the answer.

`shopfloor-authorize` is unchanged and still ships: it is the spend gate alone,
for a caller that wants the permission question answered without the rest.

### Authorization — the spend gate

On a public repository, anyone who can add a label can start a run that spends
your Claude subscription. This is the only guardrail here whose failure mode is
financial and adversarial rather than operational, so it ships as its own bin
and runs in a job that has installed nothing:

```yaml
jobs:
  authorize:
    if: github.event.label.name == 'agent:implement'
    runs-on: ubuntu-latest
    env:
      GH_TOKEN: ${{ secrets.AGENT_PAT }}
    steps:
      # No checkout, no toolchain, no install — the guard runs before the spend
      # it guards. A refusal exits non-zero, which fails this job, which skips
      # every job that `needs:` it.
      - run: npx -y @galosandoval/shopfloor@<version> shopfloor-authorize
```

`GITHUB_ACTOR` and `GITHUB_REPOSITORY` come from the runner. The probe is
`gh api repos/{repo}/collaborators/{actor}/permission --jq '.role_name // .permission'`,
and the run proceeds only for `admin`, `maintain`, or `write` — a `triage`
collaborator can label an issue and therefore trigger the loop, and labeling is
not spending. It reads `role_name` rather than the endpoint's legacy
`permission` field, which reports only `admin` / `write` / `read` / `none` and
would collapse `maintain` into `write` and `triage` into `read`; an API old
enough not to send `role_name` falls back to it rather than refusing. An
organization's **custom repository role** is a name this guard has never seen,
so it is `undetermined` rather than allowed.

That set (`SPENDING_PERMISSIONS`, exported) is **fixed rather than
configurable**, for the reason the label vocabulary is: a stated set could only
be validated against a role model this package does not own, and the failure
mode here is not a broken diagnostic but a silently reopened spend gate.

**It refuses on uncertainty, and it is the only guard here that does.**
Everywhere else in this package an unreadable signal proceeds, because a
missing diagnostic should not cause an outage. Here an unreadable signal means
"I do not know whether this person may spend your money." So a `gh` that is
missing, unauthenticated, rate-limited, or answering with a permission level
the guard does not recognize all refuse, and the verdict says which of two
things happened:

| `refusal`       | Means                                                    |
| --------------- | -------------------------------------------------------- |
| `not-permitted` | The probe answered, and the answer was no                |
| `undetermined`  | The probe answered nothing usable — refused, not assumed |

They are kept apart for the reason the doctor keeps `unknown` apart from
`wrong`: one is a trespasser and the other is a broken token, and a message
that conflates them files an outage under a security incident. The refusal
names the actor and what would unblock them.

**It writes nothing.** Unlike preflight refusal, this one neither labels nor
comments — a refusal that commented would hand any drive-by triager a way to
make the harness write to your repository. The exit code is the whole output.

For a caller that wants the verdict rather than a process:

```ts
import { runAuthorization } from '@galosandoval/shopfloor'

const { verdict } = await runAuthorization({
  actor: 'octocat',
  repo: 'galosandoval/recipe-chat'
})
if (!verdict.authorized) {
  console.error(`${verdict.refusal}: ${verdict.reason}`)
}
```

`evaluateAuthorization` is the pure decision underneath, if you probed the
permission another way, and `SPENDING_PERMISSIONS` is the set it judges
against. An actor or repository that is not a well-formed GitHub login /
`owner/repo` is `undetermined` and never probed: the probe path is built by
interpolation, and a target that could address a different endpoint is not one
whose answer is worth trusting.

### Preflight refusal

`runPhase` refuses a run before it spends any tokens when the issue is a PRD
(it has native sub-issues), a native sub-issue of a parent, or an issue that
already has an open PR targeting it. The refusal comes back as
`{ ran: false, refusal: 'preflight', reason }`.

**Only on the human edge.** A retrigger continues a run whose PR is already
open, so asking there would refuse every continuation on the evidence that the
previous attempt worked.

It is the one refusal that writes: the judgement is about the issue, so it
applies the `refused` row of the transition table below and posts a comment
explaining why — naming `ready-for-agent` (exported as `ENTRY_LABEL`) as the
label to re-add to retry, since that is the one the loop's trigger watches and
the one the refusal just dropped.

Because it applies a transition, it verifies the label vocabulary first and
**throws** an `ImplementAgentError` if the repository is missing any of it —
before reading the issue, and whatever the verdict would have been. That is a
different failure from a refused verdict: a verdict says this issue must not be
implemented and is answered by labelling it, and labelling is exactly what an
unconfigured repository cannot be trusted to do. Run `npx shopfloor-init` to
create what is missing.

`evaluatePreflight` is the pure decision function underneath, exported for your
own tooling if you already have the sub-issue count, parent number, and linking
PRs gathered another way:

```ts
import { evaluatePreflight } from '@galosandoval/shopfloor'

const verdict = evaluatePreflight({
  subIssueCount: 0,
  parentNumber: null,
  linkingPullRequests: []
})
```

### Issue state and the label vocabulary

Six labels, **fixed and package-owned** — the harness's own run state and the
process lifecycle either side of it:

| Label               | Means                                                        |
| ------------------- | ------------------------------------------------------------ |
| `ready-for-agent`   | Spec is ready for an agent to implement                      |
| `ready-for-human`   | The agent is done — a human owns the next move               |
| `agent:implement`   | The implement phase owns this issue                          |
| `agent:in-progress` | A run is in flight — do not start a second one on this issue |
| `agent:blocked`     | A run refused or could not proceed — a human must unblock it |
| `agent:exhausted`   | A run hit its ceiling without passing the gate               |

They are not configurable, and that is the one place this package names things
in your repository. A name the harness does not own is a binding it cannot
guarantee — it could only ever be validated against a mapping you hold. The
concrete cost of not owning them is in the precondition above. `npx
shopfloor-init` creates them; `LABEL_VOCABULARY` carries each one's colour and
description, and `REQUIRED_LABELS` is just the names.

**The state machine is a table**, one row per run outcome, exported so your CI
glue applies the same transition the harness does rather than a second guess at
it:

| Outcome     | Leaves the issue carrying              |
| ----------- | -------------------------------------- |
| `started`   | `agent:implement`, `agent:in-progress` |
| `succeeded` | `ready-for-human`                      |
| `exhausted` | `agent:exhausted`, `ready-for-human`   |
| `failed`    | `agent:blocked`, `ready-for-human`     |
| `refused`   | `agent:blocked`, `ready-for-human`     |

```ts
import { applyLabelTransition } from '@galosandoval/shopfloor'

await applyLabelTransition({
  issueNumber: '123',
  repo: 'galosandoval/recipe-chat',
  outcome: 'succeeded'
})
```

Four properties are worth knowing before you wire it in:

- **Each row is a target, not a list of edits.** The edits are derived against
  the issue's real labels, so applying the same outcome twice writes nothing
  the second time, and any starting state — including one a human left by
  editing labels mid-run — lands correctly.
- **Only these six labels are ever removed.** Your own labels are untouched.
- **`ready-for-human` is set by every terminal outcome**, whatever the run
  produced. It marks whose move it is, not whether the work is good; the
  `agent:` labels say which kind of attention is wanted. `exhausted` and
  `failed` stay distinct for the same reason — _the work is harder than
  specified_ and _something is broken_ are different human responses.
- **A failed `gh` throws.** It is not swallowed, because swallowing it is the
  original bug.

`evaluateLabelTransition` is the pure function underneath, and
`TRANSITION_TABLE` / `RUN_OUTCOMES` are the table and its outcomes if you want
to render or exhaustively switch on them. `applyLabelTransition` reads the
issue's current labels itself unless you pass `currentLabels` — pass them if
you already have them and save a round trip.

**`runPhase` applies every row itself** (shopfloor#47): `refused` when
preflight refuses, `started` before the branch exists, and `succeeded`,
`exhausted`, or `failed` on the way out — the failing ones inside the `catch`,
before the error is rethrown, so no way out of a started run leaves an issue in
`agent:in-progress`. The table stays exported anyway: your own tooling acting
on a run should apply _the_ transition rather than a second guess at it.

### Command guard

Three operations an autonomous run must never perform — pushing a Prisma
schema straight at the database instead of writing a migration, force-pushing,
and amending — are blocked at tool-call time rather than asked for in the
prompt. A phase run arms this automatically: the invocation carries a
`--settings` payload wiring a `PreToolUse` hook over `Bash` at the shipped
hook script, and a matching command exits `2` with the reason and the
sanctioned alternative on stderr, which the CLI feeds back to the agent as a
refusal. It fires under `--dangerously-skip-permissions` too — that flag skips
the human prompt, not the hooks.

Nothing to configure, and nothing leaks into a human's own settings for the
same checkout: the payload is session-scoped, passed inline on the command
line. Prompts still say _why_ the rules exist; enforcement no longer depends
on the model remembering them.

`classifyCommand` is the pure decision function underneath — a command string
in, `{ decision: 'allow' }` or `{ decision: 'block', rule, reason,
alternative }` out:

```ts
import { classifyCommand } from '@galosandoval/shopfloor'

classifyCommand('bunx prisma migrate dev --name add_pantry') // { decision: 'allow' }
classifyCommand('git push --force origin main').decision // 'block'
```

It reads the command as a quote-aware token stream and checks every segment of
a `&&` / `||` / `;` / `|` chain, so flag order, short flags (`-fu`),
package-runner prefixes, leading-`+` refspecs (`git push origin +main`), and
chained commands all classify the same; a forbidden flag inside a quoted
string is data (a commit message mentioning `--amend` commits fine). The rule
set is deliberately fixed and small: it is what this harness's own loop
forbids, not a general shell allowlist.

A run **refuses to start** if it can't find the hook script
beside its own bundle — a broken install fails the run rather than quietly
running it unguarded. The hook itself fails the other way on purpose: input it
can't read or classify exits 0, so the guard never takes a run down over a
command it has no opinion about.

### Verify-comment posting

`runPhase` posts the agent's verify-phase report and any committed screenshots
back to the PR it just opened, pinned to the commit it just pushed — not to
`GITHUB_SHA`, which on that path names a branch tip several commits behind the
screenshots the comment links to.

Best-effort by contract: verify never blocks a PR, so a failure here comes back
as `verifyCommentPosted: false` rather than as a failed run.

`buildVerifyComment` is the pure formatter underneath, exported so your own
tooling can render the same comment:

```ts
import { buildVerifyComment } from '@galosandoval/shopfloor'

const body = buildVerifyComment({
  report: '## What I verified\n...',
  repo: 'galosandoval/recipe-chat',
  ref: 'a1b2c3d',
  screenshots: ['.agent/verify/issue-123/search.png'],
  runUrl: 'https://github.com/o/r/actions/runs/1'
})
```

### Trajectory scorecard

Grade a finished run over its own captured transcript — _how_ it worked, not
just what it produced:

```ts
import { runTrajectoryCheck } from '@galosandoval/shopfloor'

const { graded, findings, scorecard } = runTrajectoryCheck({
  transcriptFile: '/tmp/out/transcript.jsonl',
  maxTurns: 150,
  // Optional: where to stage the markdown for `gh pr comment --body-file`.
  scorecardFile: '/tmp/out/trajectory_scorecard.md'
})
```

Four process invariants, each graded `pass`, `fail`, or `not-evaluable`:

| Invariant              | Fails when                                                       |
| ---------------------- | ---------------------------------------------------------------- |
| `gate-before-commit`   | A `git commit` was not preceded by a whole-suite test run        |
| `red-before-green`     | No failing test run preceded the first commit                    |
| `no-forbidden-git-ops` | The run force-pushed or amended                                  |
| `turn-budget-headroom` | Turn usage reached the headroom threshold (default: ≥80% of cap) |

**`runTrajectoryCheck` itself is advisory.** It reports, never throws, and
never changes an exit code. A missing or unreadable transcript returns
`graded: false` rather than an error, and an empty or truncated one grades
every invariant `not-evaluable`.

**Two of the four now close a run, though.** See
[the closure condition](#the-closure-condition) below: `runPhase` grades every
attempt against this checker before it may succeed.

What counts as the gate is per-repository. The default recognizes a whole-suite
run under npm, pnpm, yarn, or bun (and jest/vitest invoked directly), excluding
partial scripts like `test:e2e`; a repo whose gate is something else states
`gateCommandPatterns`, which replaces the defaults outright.
`no-forbidden-git-ops` defers to the same `classifyCommand` rule set the
`PreToolUse` guard enforces, so the two can't drift.

`checkTrajectory` is the pure grader underneath (already-parsed events in,
findings out) and `formatScorecard` renders findings as markdown — both
exported for callers assembling their own reporting.

### The closure condition

A green quality gate is necessary and no longer sufficient. Every attempt a run
makes is graded against the checker above before the run may finish, so an
agent that reached green by deleting a failing test does not exit as a success.

Two of the four invariants gate:

| Invariant              | Gating? | Why                                                                     |
| ---------------------- | ------- | ----------------------------------------------------------------------- |
| `gate-before-commit`   | **yes** | The implement phase's own contract, and what a shortcut to green breaks |
| `red-before-green`     | **yes** | Same                                                                    |
| `no-forbidden-git-ops` | no      | The `PreToolUse` command guard already refuses these at spawn time      |
| `turn-budget-headroom` | no      | A capacity signal — a long run did nothing wrong                        |

What a run does about a gating violation:

- **Attempts left** — it spawns again, with the violated invariants appended to
  the prompt. This spends from the same `maxIterations` / wall-clock budget a
  red gate does. A run with no `gateCommand` stated can iterate here, and only
  here: the trajectory is a signal that needs no configuration from you.
- **No attempts left** — the run fails. `runPhase` labels the issue
  `agent:blocked` + `ready-for-human`, pushes the branch, opens no PR, and
  comments on the issue naming the invariants. Deliberately not
  `agent:exhausted`, which means _the work is harder than specified_; this
  means _something is wrong_.
- **No transcript captured for the attempt** — the run is blocked, not passed,
  and does not spend another attempt on it. It is the _capture_ that is
  checked, not whether a file is readable: a failed capture leaves the previous
  attempt's transcript in place, and grading that would close the run on
  evidence about a different attempt. This is the one guardrail here that refuses on
  an unreadable signal without being about spend: a definition of done that an
  absent file satisfies is not one. **It is also the new failure mode in this
  release** — a consumer whose transcript capture does not work will see runs
  block that previously reached `ready-for-human`.

Grading uses the package's default gate-command patterns _plus_ your own
`runPolicy.gateCommand` matched literally, so a repository whose gate is
`make check` is graded on `make check`.

`evaluateClosure` is the pure decision (scorecard and remaining budget in,
`pass` / `re-enter` / `block` out) and `GATING_TRAJECTORY_INVARIANTS` is the
stated list — both exported so your own tooling can ask what a run asks. A
block travels out on `ImplementAgentError.closure`.

### The handoff trail

Every run used to start cold, and a failed one taught the next nothing — which
is fine for a single-shot harness and fatal with an outer loop, because a
bounded loop over identical attempts is not a feedback loop.

Each attempt that does **not** succeed leaves a file at
`.agent/attempts/<run-id>.md`, committed to the branch, and the next attempt
reads the whole trail through `{{ATTEMPTS_DIR}}` — **all** of it, not just the
last one. Attempt 3 learning only from attempt 2 is how a loop oscillates
between two wrong approaches.

**Two authors, never blended.**

- **Harness-authored**, and load-bearing: the CI failure that triggered the
  edge (a bounded tail of `gh run view --log-failed`, plus the run URL), the
  trajectory scorecard, the run id, and the diff. **Written unconditionally** —
  after a runaway kill, after a crash inside the run, after an exhausted
  ceiling. Those are exactly the attempts the ceiling exists to stop, and the
  ones that would otherwise teach the next iteration nothing.
- **Agent-authored**, and marked as _claims_: what the agent tried, what it
  abandoned, what it believes the root cause is, read back from
  `{{HANDOFF_CLAIMS_FILE}}` and quoted verbatim under an unverified heading. An
  agent that just failed is the least reliable narrator of why. When it wrote
  none — a kill, usually — the document **says so**, naming the file it looked
  in, rather than omitting the section. It does not guess at _why_ the file is
  empty: a kill and an agent that skipped it look identical from here, and how
  the attempt ended is already stated from the error the run threw.

Each document also states **what that attempt spent** — the four token buckets
and the cost, off `usage` (below), with `source` saying whether the CLI reported
the total or the harness observed part of it. The ceiling bounds attempts; the
argument for raising or lowering it is in tokens, and the trail is where a human
reads both at once.

Everything is bounded and the bounds are stated: `HANDOFF_LOG_TAIL_LIMIT`,
`HANDOFF_DIFF_LIMIT`, and `HANDOFF_CLAIMS_LIMIT` are exported constants, and a
truncated section says it was truncated. Unbounded logs are how a handoff
becomes context rot one iteration at a time. A log fetch that fails degrades the
document to URL-only rather than blocking the loop.

**The trail is stripped on success**, in the commit the successful run is about
to push — the lifecycle the verify screenshots follow. That commit is also what
marks the loop closed on the branch, so it is made even when there was no trail
to strip (empty, in that case): the mark has to be on the head commit, and a
first-attempt success has nothing to delete. It is **kept** on the
exhausted terminal state — the PR stays open and the trail is the best account
anyone has of what went wrong — and kept on an ordinary failure, because the
next attempt is the reason it was written.

The commits are authored as `claude-code[bot]` and skip your hooks
(`--no-verify`). Both are deliberate: the machine edge is keyed on the head
commit's author, so a handoff committed under the runner's ambient identity
would stop the retrigger this artifact exists to inform, and a pre-commit hook
failing is not a reason to lose the only record of why the attempt failed.

`renderHandoff` is the pure document (facts in, markdown out) and is exported,
along with `DEFAULT_ATTEMPTS_DIR`, for glue that reads or reproduces the trail.

### The terminal state

When the attempt ceiling is spent, the issue gets `agent:exhausted` — never
`agent:blocked` — and the accumulated handoff trail as a comment. The two are
the failures with the most different human responses in the system: _fix the
issue's shape_ versus _the work is harder than specified, or the spec is wrong_.
The trail is posted because it is already written and is already the best
account of what went wrong; the alternative is opening N commits to reconstruct
it. **The pull request stays open and the trail is not stripped** — closing the
PR discards partial work, and the trail is the evidence the comment is made of.

It is written by the **admission job**, because that job is the last place the
ceiling is observed: the expensive job is gated on the verdict, so nothing
downstream survives to apply a row. `shopfloor-admit` does it for you; a caller
driving the callables themselves does it with `reportExhaustion`, off the
`ceiling` the `exhausted` verdict carries:

```ts
const verdict = await runAdmission()

if (!verdict.admitted && verdict.refusal === 'exhausted' && verdict.ceiling) {
  await reportExhaustion({ ceiling: verdict.ceiling })
}
```

It reads the trail off the branch through `gh api` (that job has no checkout),
posts the comment, then applies the row — the comment first, because the label
without it says a human is needed and not what for. **It reports once**: a
stateless edge trips the same ceiling on every later event, and
`agent:exhausted` already on the issue is what says the report happened.
Nothing here throws; the loop has already ended, and what it could not do comes
back on the result. `buildExhaustionReport` is the pure decision underneath,
and `EXHAUSTION_COMMENT_LIMIT` is how much of the trail one comment carries.

### Setup doctor

Everything above is a string binding a consumer has to get right on their own:
two secrets, the label vocabulary, a workflow's trigger wiring, a prompt
carrying eight exact tokens, a CLI pin. None of them errors when it is wrong —
they rot silently, which is what `{{STANDARDS_DIR}}` did. One command says
which one is wrong:

```sh
PROMPT_FILE=./agent/implement/prompt.md npx shopfloor-doctor
```

```
shopfloor doctor

✓ gh is authenticated
✓ token carries workflow scope
✗ repository secrets: CLAUDE_CODE_OAUTH_TOKEN, AGENT_PAT
✗ label vocabulary
✓ claude CLI matches the pin
✗ prompt placeholder tokens
? prompt environment block is filled
✓ workflow trigger events
✓ workflow_run prerequisites
```

Nine checks, each a binding named where it fails:

| Check                        | Fails when                                                                              |
| ---------------------------- | --------------------------------------------------------------------------------------- |
| `gh-auth`                    | `gh` is not authenticated                                                               |
| `pat-workflow-scope`         | The token you are running as has no `workflow` scope                                    |
| `repo-secrets`               | A required secret is in neither the repository's nor the organization's secrets         |
| `label-vocabulary`           | One of the six labels the loop transitions over does not exist                          |
| `cli-version-pin`            | The running `claude --version` differs from the pin on `major.minor`                    |
| `prompt-tokens`              | The prompt is missing a substituted token, or carries an unrecognized one               |
| `prompt-environment-block`   | The prompt's environment block is empty or still carries the `TODO(shopfloor)` sentinel |
| `workflow-triggers`          | The workflow is not wired to `issues.labeled` and `workflow_run.completed`              |
| `workflow-unfilled`          | The workflow still carries a scaffolded `TODO(shopfloor)` nobody replaced               |
| `workflow-run-prerequisites` | The workflow is off the default branch, or never references the PAT at all              |

**Read-only, and the exit code is the point.** It creates no labels, sets no
secrets, and writes no files, so it is idempotent and safe in CI; it exits
non-zero when any check fails, and zero otherwise.

**Three statuses, and only one of them fails the exit code.** `✓` passed, `✗`
found a wrong binding, and `?` means the check could not be evaluated — `gh`
isn't installed, no `PROMPT_FILE` was pointed at, no pin was stated. An unknown
prints and does not fail: a doctor that cannot read `gh` must not be
indistinguishable from a repository that is misconfigured.

Two of the checks encode requirements that are invisible in the YAML they
check. `pat-workflow-scope` and the PAT half of `workflow-run-prerequisites`
exist because **a push made with the built-in `GITHUB_TOKEN` fires no
downstream events** — so a loop wired to `workflow_run` never retriggers unless
the push used the PAT. And `workflow_run` **fires only from a workflow file on
the default branch**, which is why that check reads the default branch through
the API rather than the checkout it is running in.

**What a green doctor does not prove.** Three limits, stated so the report is
read for what it is:

- **The stored PAT's scopes cannot be read.** A secret is write-only to
  everything but Actions, and `gh secret list` returns names alone. So
  `pat-workflow-scope` judges the token _you_ are running as and infers the
  rest: a machine whose local `gh` is scoped correctly passes even if the
  stored `AGENT_PAT` is not. It catches the common case — nobody ever added the
  scope — and is not proof.
- **The PAT check is a reference check.** `workflow-run-prerequisites` asks
  whether the workflow mentions `secrets.<PAT>` anywhere, not whether the
  _pushing_ step uses it; deciding that needs job semantics a shallow read
  doesn't have. It catches "nothing uses the PAT", not "the wrong step uses
  `GITHUB_TOKEN`".
- **Environment-scoped secrets are invisible.** Repository and organization
  secrets are both read; a secret defined on a deployment environment is not,
  and reports as missing. State `REQUIRED_SECRETS` to name only what this
  doctor can see.

**`workflow-triggers` fails on today's shipped harness.** `workflow_run.completed`
is the machine edge of the outer loop, which is designed and not yet built — so
a consumer correctly set up for the `implement` phase alone sees this check fail
until that lands. It is checked now because the doctor's job is to report the
bindings the loop needs, and a check added after the loop is the check that
never gets added. Same for `label-vocabulary`: the six labels are fixed and
package-owned, and [`shopfloor-init`](#setup-init) is what creates them — at a
moment you asked for it. Nothing in a run has ever created a label, and nothing
in one ever will: a run's side of the vocabulary stays verify-and-refuse.

**`workflow-unfilled` fails on a workflow `init` just scaffolded, by design.**
The values it declines to guess — the CI workflow whose completion retriggers
the loop, the `claude` version to install — are written as `TODO(shopfloor)`
rather than as a plausible name, and this check is what refuses on them.
Without it a scaffolded repository reads fully green while its machine edge is
dead: a `workflow_run` block whose `workflows:` names a sentinel is still
wired to the event, so `workflow-triggers` passes and the edge fires from
nothing.

| Variable            | Default                                 | What it points at                            |
| ------------------- | --------------------------------------- | -------------------------------------------- |
| `PROMPT_FILE`       | — (prompt checks report unknown)        | The prompt template to check                 |
| `WORKFLOW_FILE`     | `.github/workflows/agent-implement.yml` | The agent workflow                           |
| `REQUIRED_SECRETS`  | `CLAUDE_CODE_OAUTH_TOKEN`, `AGENT_PAT`  | Comma-separated; a stated list replaces both |
| `AGENT_PAT_SECRET`  | `AGENT_PAT`                             | Which secret holds the PAT                   |
| `CLI_VERSION`       | — (no pin, nothing to compare)          | The pin to compare `claude --version` to     |
| `GITHUB_REPOSITORY` | inferred by `gh` from the checkout      | `owner/repo`                                 |

The environment block is the half of a prompt this package never ships — gate
commands, database URLs, seeded fixtures. Fence it so "unfilled" is
machine-checkable rather than a judgement about prose:

```markdown
<!-- shopfloor:environment -->

Run the gate with `bun run typecheck && bun run test`.

<!-- /shopfloor:environment -->
```

A prompt with no fences reports unknown rather than failing — an existing
prompt carrying its environment as plain prose is not wrong, only unverifiable.

`probeSetup()` gathers the facts and `evaluateSetup(facts)` is the pure verdict
underneath — both exported, along with `formatSetupReport`, `REQUIRED_LABELS`,
`PROMPT_TOKENS`, and the environment-block constants, for callers assembling
their own reporting. The check ids, the admitted events, and the configuration
defaults are deliberately not API: every export is a commitment, and nothing
outside this package needs them.

### Setup init

`doctor` says what is wrong. `init` fixes the half a command can:

```sh
npx shopfloor-init
```

```
shopfloor init

Will write:
- create 6 label(s): ready-for-agent, ready-for-human, agent:implement, … — a transition onto a label that does not exist fails silently.
- create agent/implement/prompt.md — the run has no prompt to render.
- create .github/workflows/agent-implement.yml — nothing triggers the loop without it. Merge it to the default branch — a workflow_run trigger fires from nowhere else, so the machine edge stays dead until it is there.

Still yours to fix — this command cannot:
- repo-secrets: missing: CLAUDE_CODE_OAUTH_TOKEN, AGENT_PAT — set with `gh secret set <NAME>` …
```

It runs `doctor`'s evaluation first and writes only what that verdict says is
missing: the label vocabulary, the workflow wired to both trigger events, and
the prompt — with its environment block **filled** from this project's own
lockfile and `package.json` scripts, not left as a placeholder.

**The fill is the point.** A skeleton whose environment block still says
`{{GATE_COMMAND}}` fails the way `{{STANDARDS_DIR}}` did: present, plausible,
wrong, and silent. So `init` reads `pnpm-lock.yaml` and a `typecheck` script and
writes the commands, and where it **cannot** determine a value it writes the
sentinel `TODO(shopfloor)` — which `doctor`'s `prompt-environment-block` check
already fails on. Never an empty string, and never prose a reader has to judge:

```markdown
<!-- shopfloor:environment -->

TODO(shopfloor): no lockfile at the project root, so the package manager and its
install command are undetermined — state them here.

This work is not done until `pnpm run typecheck && pnpm run test` passes.

<!-- /shopfloor:environment -->
```

The same sentinel names what the workflow scaffold cannot know: which CI
workflow's completion should retrigger the loop, and — when no `CLI_VERSION` is
stated — which `claude` version to install. Each is written inert rather than
guessed, and `doctor`'s `workflow-unfilled` check refuses on every one of them,
so a scaffolded workflow cannot read green while an edge of it is dead.

**Four properties worth relying on:**

- **Re-runnable.** A second run on a configured repository writes nothing —
  every check its writers address already passes, so the plan is empty.
- **Never a silent overwrite.** An existing file is either left alone or
  rewritten after you confirm, by name. With no terminal attached to answer —
  in CI — every overwrite is declined.
- **It leaves a prompt it cannot account for alone.** Three cases, all of them
  a refusal to write: a prompt with no environment fences (its environment is
  prose this command cannot locate); a rewrite for a missing _token_ over a
  prompt whose environment you filled (yours is kept verbatim, and the report
  says so); and a block still carrying the sentinel on a project that states
  nothing to fill it with — re-deriving the same sentinel would put an
  overwrite in front of you on every run, over a file `init` itself wrote.
- **No config file.** Resolution stays `explicit input → env var → probe →
default`, the same as everywhere else here. It reads the same variables the
  doctor does, with one difference: an unstated `PROMPT_FILE` is a path to
  _create_ (`agent/implement/prompt.md`) rather than a check that reports
  unknown.

What it does not do: set secrets, authenticate `gh`, or merge the workflow to
your default branch. Those are named in the report and left to you. Every write
in the plan carries the reason it is there, and the merge rides on the action
that creates the need for it — with no workflow on disk `doctor` reports that
check as unknown rather than failing, so nothing else would tell you that the
machine edge stays dead until the file is on the default branch.

**The scaffolded workflow is a starting point you then own.** It is wired to
both trigger events, checks out with the PAT, runs the spend gate before the
runner installs anything, installs the `claude` CLI the harness spawns, and
carries a job condition that filters the label on `issues` without filtering
`workflow_run` out of existence. Both `npx` invocations and the CLI install are
pinned — to the version of this package doing the scaffolding, and to your
`CLI_VERSION` — so the workflow keeps running what it was written for rather
than whatever npm published this morning. Three things in it are deliberately
inert and marked with the sentinel: which CI workflow's completion retriggers
the loop, the CLI version when you stated none, and how a `workflow_run` event
resolves to an issue number — that last one is the outer loop, which is
designed and not shipped.

`runInit()` is the command; `formatInitResult(result)` renders what it did. The
planner, the scaffold builders, and the project probe are internal — every
export is a commitment, and nothing outside this package needs them.

## Module layout

Organized by harness concern rather than a flat file list, so a future `plan`
or `review` module has an obvious home:

- `src/phase/` — the verb: `runPhase` (the shell), the pure decisions behind
  it (`resolvePhasePrompt` with `DEFAULT_PHASE_PROMPTS`, `buildPullRequestFields`,
  `evaluatePhaseOutcome`), and the two locate-or-create shells it owns
  (`ensureAgentBranch` / `pushAgentBranch`, `ensurePullRequest`).
- `src/orchestration/` — `runImplementAgent` (the phase's own run, internal),
  `resolveImplementConfig` (pure configuration resolution),
  `prepareClaudeInvocation` (pure CLI-invocation assembly), `spawnClaude`
  (the subprocess, with both runaway guards armed around it),
  `evaluateIteration` / `runGate` (the inner loop's decision and the gate it
  decides on), and
  `resolveBundledPluginDir` (where the bundled plugin landed — filesystem work,
  so it sits in the shell rather than in the configuration resolver).
- `src/guardrails/` — the run-policy contract (idle/wall-clock/max-turns
  resolvers), the pure CLI-version comparison, preflight refusal, authorization
  (`evaluateAuthorization` / `runAuthorization` — the spend gate, and the one
  guard that refuses on uncertainty), the command
  policy and its `PreToolUse` hook script, plugin-directory validation, the
  unfilled-prompt refusal (`evaluatePromptReadiness`), the trajectory closure
  condition (`evaluateClosure` — the gate on the success path), the label-vocabulary
  refusal (`evaluateLabelVocabulary` / `runLabelVocabularyCheck` — verify and
  refuse, never create), and
  verify-comment posting (a
  feedback-loop guardrail: posting proof back to the PR).
- `src/trigger/` — the trigger boundary: the pure `classifyTrigger` over a raw
  webhook payload, the `agent/issue-<n>` branch convention both edges read and
  write, and admission — the pure `evaluateAdmission` and the `runAdmission`
  shell behind the `shopfloor-admit` bin, which composes classification, the
  spend gate, the concurrency check, and the attempt ceiling into one verdict a
  setup-free job can gate on.
- `src/issue-state/` — the label vocabulary and the state machine over it: the
  pure `evaluateLabelTransition` with its `TRANSITION_TABLE`, and the
  `applyLabelTransition` shell. The six names are package-owned.
- `src/observability/` — session transcript capture (for CI-artifact upload),
  and the trajectory checker that grades a finished run over that transcript:
  the pure `checkTrajectory` / `formatScorecard` and the `runTrajectoryCheck`
  shell. It reports; the run's own gate over it is `evaluateClosure` in
  `src/guardrails/`.
- `src/setup/` — the doctor and the scaffolder: the pure `evaluateSetup` /
  `formatSetupReport` and the read-only `probeSetup` shell, and over them the
  pure `planInit` / `buildEnvironmentBlock` (both internal) and the `runInit`
  shell that is the one thing here that writes to a consumer's repository. It
  judges and configures a consumer's setup rather than a run.
- `src/handoff/` — memory: the pure `renderHandoff` (two authorship halves, one
  file per attempt, every section bounded) and the `writeHandoff` /
  `closeLoop` shell that commits the trail to the branch and removes it on
  success. The one module whose output is written for an _agent_ to read.
- `src/process/` — what every shell that shells out needs and none of them own:
  the one narrowing of a rejected `execFile` (`asExecFailure`) and the
  `node:child_process` stub their wiring tests share. Internal; nothing here is
  exported from `src/index.ts`.

The package exports **one verb for the loop** — `runPhase` — alongside the
commands that are not the loop (`runAuthorization` and `runAdmission`, the
setup-free gates in front of it; `runTrajectoryCheck`, `probeSetup`, and
`runInit`, which judge or configure rather than run) and `ImplementAgentError`,
the
documented pure escape hatches (`evaluatePreflight`, `evaluateAuthorization`,
`buildVerifyComment`,
`classifyCommand`, `checkTrajectory` with `formatScorecard`, `evaluateIteration`
(the inner loop's iterate/done/exhausted rule), `evaluateClosure` with
`GATING_TRAJECTORY_INVARIANTS` (the trajectory closure condition), `evaluateSetup` with
`formatSetupReport`, and
`evaluatePluginDirs`, and `evaluatePromptReadiness`, the unfilled-prompt refusal, and the trigger
boundary's `classifyTrigger` and `evaluateAdmission`),
`formatInitResult` (what a finished `init` did),
`resolveBundledPluginDir` (where the bundled plugin landed),
`DEFAULT_RUN_POLICY`, `SPENDING_PERMISSIONS` (the fixed set the spend gate
judges against), `REQUIRED_LABELS` with `LABEL_VOCABULARY`, the issue-state
machine (`applyLabelTransition` with the pure `evaluateLabelTransition`,
`TRANSITION_TABLE`, and `RUN_OUTCOMES`) and the vocabulary check behind the
precondition (`evaluateLabelVocabulary` with `runLabelVocabularyCheck`),
`PROMPT_TOKENS`,
the environment-block constants, the branch convention
(`agentBranchForIssue`, `issueNumberFromBranch`, `AGENT_BRANCH_PREFIX`) and
`PHASES` with `DEFAULT_MAX_ATTEMPTS`, and the input/result types — including
`CliVersionStrictness`, the union behind the strictness table above. The
resolvers, the invocation assembler, the transcript helpers, and everything
`init` decides with (`planInit`, the scaffold builders, the project probe) are
internals — import from source if you're vendoring, but they aren't API.

## Tests vs. evals

This package has **tests**: unit coverage on every pure function
(`evaluatePreflight`, `buildVerifyComment`, `classifyCommand`,
`resolveImplementConfig`, `prepareClaudeInvocation`, the run-policy resolvers,
`checkCliVersion`, `evaluatePluginDirs`, transcript capture) that
asserts on inputs/outputs, no IO mocking. It does **not** have **evals** — no scored suite over labeled
trajectories or an LM-judge check of whether an actual agent run produced a
_good_ implementation. The `implement` phase's best-effort Playwright verify
step is a runtime signal, not an eval suite. This is a named, known gap, not
an implied guarantee — deterministic correctness of the harness's own
functions is covered; judgment-quality of what the agent produces is not.

## Versioning

This package is pre-`1.0.0`, and `0.x` minors may carry behavior changes — the
configuration surface (`RunPolicyConfig` in particular) is still moving.
Semver's "minor is additive" guarantee does not apply below `1.0.0`, so
**consumers should exact-pin** the version they tested — no `^`, no `~` —
until `1.0.0`, and upgrade deliberately.

`CHANGELOG.md` is authoritative for what changed in a release, including
behavior changes. Read it before every bump; the version number alone won't
tell you whether a release is safe to take.

Releases run through [Changesets](https://github.com/changesets/changesets).
Every PR needs a changeset (`npx changeset`); a PR that deliberately ships
nothing records an explicit empty one (`npx changeset --empty`) rather than
leaving "this doesn't release" to be inferred from silence. A releasing PR runs
`npm run version:packages` on its own branch and commits the result, so it
carries its version bump and `CHANGELOG.md` entry; merging it to `main` tags the
commit and publishes to npm with provenance via an OIDC trusted publisher —
there is no `NPM_TOKEN` in this repo. CI never pushes to `main`.

## License

MIT
