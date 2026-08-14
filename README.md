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

This package deliberately does **not** ship a GitHub Actions workflow
template or a prompt template — those are per-consumer. See
[`galosandoval/recipe-chat`](https://github.com/galosandoval/recipe-chat)'s
`.github/workflows/agent-implement.yml` and `agent/implement/prompt.md` for a
reference wiring — read it as a shape, not as a copy-paste: it predates the
`standardsDir` removal below and still clones a standards directory, which now
refuses the run.

## Install

```sh
npm install @galosandoval/shopfloor
```

Requires Node 20+ and the `claude` and `gh` CLIs on `PATH` — this package
shells out to both rather than wrapping an SDK.

## Usage

```ts
import { runImplementAgent, ImplementAgentError } from '@galosandoval/shopfloor'
import * as fs from 'node:fs'

try {
  const result = await runImplementAgent({
    issueNumber: '123',
    issueTitle: 'Add pantry filter to recipe search',
    branch: 'agent/issue-123-pantry-filter',
    claudeCodeOAuthToken: process.env.CLAUDE_CODE_OAUTH_TOKEN!,
    standardsDir: '/tmp/skills/rules',
    promptTemplate: fs.readFileSync('prompt.md', 'utf8'),
    prDescriptionFile: '/tmp/out/pr_description.txt',
    verifyReportFile: '/tmp/out/verify_report.md',
    screenshotsDir: '.agent/verify/issue-123',
    transcriptFile: '/tmp/out/transcript.jsonl',
    projectsDir: `${process.env.HOME}/.claude/projects`,
    runPolicy: {
      model: 'claude-opus-4-8',
      maxTurns: 150,
      cliVersion: '2.1.208',
      idleMinutes: 15,
      wallClockMinutes: 45,
      // The caller's own app-specific env vars — this package bakes in none.
      requiredEnvVars: ['DATABASE_URL', 'OPENAI_API_KEY', 'GH_TOKEN']
    }
  })
  console.log(`${result.commitsAhead} commit(s) made.`)
} catch (error) {
  if (error instanceof ImplementAgentError) {
    console.error(error.message, error.outputTail)
  }
  throw error
}
```

State a field only where you disagree with what would be inferred:

```ts
import { resolveBundledPluginDir } from '@galosandoval/shopfloor'

await runImplementAgent({
  issueNumber: '123',
  issueTitle: 'Add pantry filter to recipe search',
  branch: 'agent/issue-123-pantry-filter',
  repo: 'galosandoval/recipe-chat',
  claudeCodeOAuthToken: process.env.CLAUDE_CODE_OAUTH_TOKEN!,
  promptTemplate: fs.readFileSync('prompt.md', 'utf8'),
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
    // Omitted, a run has no wall-clock ceiling — only the idle guard.
    wallClockMinutes: 45,
    // The CLI version this policy was validated against. A mismatch on
    // major.minor warns by default; 'error' refuses the run, 'off' skips.
    cliVersion: '2.1.220',
    cliVersionStrictness: 'warn',
    // The caller's own app-specific env vars — this package bakes in none.
    requiredEnvVars: ['DATABASE_URL', 'OPENAI_API_KEY', 'GH_TOKEN']
  }
})
```

### The prompt template

The template is yours — this package ships none. Before the spawn, its
`{{PLACEHOLDER}}` tokens are rendered against the run's own resolved values.
Six are substituted, and only these six:

| Token                     | Rendered to                                                    |
| ------------------------- | -------------------------------------------------------------- |
| `{{ISSUE_NUMBER}}`        | `issueNumber`, as resolved                                     |
| `{{ISSUE_TITLE}}`         | `issueTitle` — stated, from `ISSUE_TITLE`, or probed via `gh`   |
| `{{BRANCH}}`              | `branch` — stated, from the environment, or probed via `git`    |
| `{{PR_DESCRIPTION_FILE}}` | absolute path the agent writes its PR description to           |
| `{{VERIFY_REPORT_FILE}}`  | absolute path the agent writes its verify report to            |
| `{{SCREENSHOTS_DIR}}`     | repo-relative directory the agent commits verify screenshots to |

The last three are how a prompt tells the agent where to put the artifacts this
package then reads back — a template that never names them yields a run with no
PR description (`prDescription: 'fallback'`) and nothing to post.

**An unrecognized token renders as literal text**, unchanged and unreported —
there is no error for a misspelled placeholder, and none for a token that used
to exist. `{{STANDARDS_DIR}}` is exactly that case now; see
[Pre-spawn preconditions](#pre-spawn-preconditions). Check your template against
this table when you upgrade.

### What a run returns

A resolved run answers with `RunImplementAgentResult`:

| Field                | Type                    | Meaning                                                                              |
| -------------------- | ----------------------- | ------------------------------------------------------------------------------------ |
| `branch`             | `string`                | The branch committed on, as resolved — stated, inferred, or probed                   |
| `commitsAhead`       | `number`                | Commits on `branch` since `main`, per `git rev-list --count`                         |
| `prDescription`      | `'agent' \| 'fallback'` | Whether the agent wrote its own PR description, or this run supplied one             |
| `transcriptCaptured` | `boolean`               | Whether the session transcript was found and copied to `transcriptFile`              |
| `cliVersion`         | `string \| undefined`   | The CLI version this run spawned; undefined when that probe failed or was unreadable |

`prDescription: 'fallback'` and `transcriptCaptured: false` are **not**
failures — the run committed either way. They are there so CI glue can say so
in the PR rather than presenting generated prose as the agent's own, or an
absent transcript as an uploaded one.

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
| `projectsDir`                    | `PROJECTS_DIR`              | —               | `~/.claude/projects`                                  |
| `runPolicy.model`                | `MODEL`                     | —               | none — the Claude CLI's own default                   |
| `runPolicy.maxTurns`             | `MAX_TURNS`                 | —               | `150`                                                 |
| `runPolicy.idleMinutes`          | `IDLE_MINUTES`              | —               | `15`                                                  |
| `runPolicy.wallClockMinutes`     | `WALL_CLOCK_MINUTES`        | —               | none — the run has no wall-clock ceiling              |
| `runPolicy.cliVersion`           | `CLI_VERSION`               | —               | none — the running version is recorded, not compared  |
| `runPolicy.cliVersionStrictness` | `CLI_VERSION_STRICTNESS`    | —               | `'warn'`                                              |
| `runPolicy.requiredEnvVars`      | `REQUIRED_ENV_VARS`         | —               | `[]`                                                  |

`promptTemplate` is the raw template **contents**, not a path — the library
never reads a file for it, so it carries no environment variable. `PROMPT_FILE`
is the CLI entrypoint's own convenience: the bin reads that path and passes the
contents in. It is the one variable in this document that does not work against
`runImplementAgent`.

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
case below, where the commits were finished and only the prose was absent.

#### Pre-spawn preconditions

Three things are settled just before the CLI spawns, so a misconfigured run
costs zero tokens: the `runPolicy.requiredEnvVars` check, the plugin
directories, and the CLI version. A fourth refuses earlier still, while the
configuration resolves, because it needs nothing from disk to detect: a
standards directory.

**A standards directory — fails the run.** `standardsDir` is gone, and the
prompt no longer carries a `{{STANDARDS_DIR}}` placeholder to substitute into;
skills reach the agent through the CLI's own plugin discovery instead. A run
that still states `standardsDir`, or whose environment still sets a non-empty
`STANDARDS_DIR`, **refuses before spawning** and names the replacement. That
refusal is the migration: dropping the field quietly would leave a CI-set
variable meaning nothing at all — no type error, no runtime error, just a run
with less context than its operator believes it has. An empty value from either
source still means "deliberately skip" and does not refuse, exactly as before.

A prompt template that still contains `{{STANDARDS_DIR}}` now renders that
token as literal text. Fixing the configuration is what a run demands first, so
this is reachable only by a caller who does that and leaves the template stale
— check yours when you upgrade.

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

A thin bin entrypoint reads the equivalent shape from env vars, for a
drop-in CI step:

```sh
ISSUE_NUMBER=123 \
ISSUE_TITLE="Add pantry filter to recipe search" \
BRANCH=agent/issue-123-pantry-filter \
CLAUDE_CODE_OAUTH_TOKEN=*** \
PROMPT_FILE=./prompt.md \
MODEL=claude-opus-4-8 \
MAX_TURNS=150 \
CLI_VERSION=2.1.208 \
IDLE_MINUTES=15 \
WALL_CLOCK_MINUTES=45 \
REQUIRED_ENV_VARS=DATABASE_URL,OPENAI_API_KEY,GH_TOKEN \
npx shopfloor-implement
```

Optional: `STANDARDS_DIR`, `OUTPUT_DIR` (default: OS tmpdir; derives
`pr_description.txt`/`verify_report.md`/`transcript.jsonl`/`failure_reason.txt`
under it), `SCREENSHOTS_DIR` (default: `.agent/verify/issue-<ISSUE_NUMBER>`),
`PROJECTS_DIR` (default: `~/.claude/projects`), and
`LOCAL_IDLE_MINUTES`/`LOCAL_WALL_CLOCK_MINUTES` to override the guard budgets
for a single run without touching the contract.

### Preflight refusal

Refuse a label-triggered run before it spends any tokens — a PRD (has native
sub-issues), a native sub-issue of a parent, or an issue that already has an
open PR targeting it:

```ts
import { runPreflight } from '@galosandoval/shopfloor'

const { verdict } = await runPreflight({
  issueNumber: '123',
  repo: 'galosandoval/recipe-chat'
})
if (verdict.refused) {
  console.log(verdict.reason)
}
```

`evaluatePreflight` is the pure decision function underneath, if you already
have the sub-issue count / parent number / linking PRs gathered another way.

### Verify-comment posting

Post the agent's verify-phase report and any committed screenshots back to
the PR as a comment:

```ts
import { postVerifyComment } from '@galosandoval/shopfloor'

await postVerifyComment({
  issueNumber: '123',
  repo: 'galosandoval/recipe-chat-v1',
  prNumber: '456',
  sha: process.env.GITHUB_SHA!,
  runUrl: 'https://github.com/galosandoval/recipe-chat-v1/actions/runs/1',
  verifyReportFile: '/tmp/out/verify_report.md',
  screenshotsDir: '.agent/verify/issue-123'
})
```

Best-effort by contract — it never throws; check the returned `posted` flag.
`buildVerifyComment` is the pure formatter underneath.

## Module layout

Organized by harness concern rather than a flat file list, so a future `plan`
or `review` module has an obvious home:

- `src/orchestration/` — `runImplementAgent` (the orchestrator) and
  `prepareClaudeInvocation` (pure CLI-invocation assembly).
- `src/guardrails/` — the run-policy contract (idle/wall-clock/max-turns
  resolvers), preflight refusal, and verify-comment posting (a feedback-loop
  guardrail: posting proof back to the PR).
- `src/observability/` — session transcript capture, for CI-artifact upload.

## Tests vs. evals

This package has **tests**: unit coverage on every pure function
(`evaluatePreflight`, `buildVerifyComment`, `prepareClaudeInvocation`, the
run-policy resolvers, transcript capture) that asserts on inputs/outputs, no
IO mocking. It does **not** have **evals** — no scored suite over labeled
trajectories or an LM-judge check of whether an actual agent run produced a
*good* implementation. The `implement` phase's best-effort Playwright verify
step is a runtime signal, not an eval suite. This is a named, known gap, not
an implied guarantee — deterministic correctness of the harness's own
functions is covered; judgment-quality of what the agent produces is not.

## Versioning

This package is pre-`1.0.0`, and `0.x` minors may carry behavior changes — the
configuration surface (`RunPolicyConfig` in particular) is still moving.
Semver's "minor is additive" guarantee does not apply below `1.0.0`, so
**consumers should exact-pin** (`"@galosandoval/shopfloor": "0.1.0"`, no `^`)
until `1.0.0` and upgrade deliberately.

`CHANGELOG.md` is authoritative for what changed in a release, including
behavior changes. Read it before every bump; the version number alone won't
tell you whether a release is safe to take.

Releases run through [Changesets](https://github.com/changesets/changesets).
Every PR needs a changeset (`npx changeset`); a PR that deliberately ships
nothing records an explicit empty one (`npx changeset --empty`) rather than
leaving "this doesn't release" to be inferred from silence. Merging to `main`
opens or updates a "Version Packages" PR; merging *that* bumps the version,
tags the commit, and publishes to npm with provenance via an OIDC trusted
publisher — there is no `NPM_TOKEN` in this repo.

## License

MIT
