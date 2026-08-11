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
[`galosandoval/recipe-chat-v1`](https://github.com/galosandoval/recipe-chat-v1)'s
`.github/workflows/agent-implement.yml` and `agent/implement/prompt.md` for a
reference wiring.

## Install

```sh
npm install @galosandoval/shopfloor
```

Requires Node 20+ and the `claude` and `gh` CLIs on `PATH` — this package
shells out to both rather than wrapping an SDK.

## Usage

A run needs an issue number, a prompt template, and an OAuth token.
Everything else is inferred:

```ts
import { runImplementAgent, ImplementAgentError } from '@galosandoval/shopfloor'
import * as fs from 'node:fs'

try {
  const result = await runImplementAgent({
    issueNumber: '123',
    promptTemplate: fs.readFileSync('prompt.md', 'utf8')
  })
  console.log(`${result.commitsAhead} commit(s) on ${result.branch}.`)
} catch (error) {
  if (error instanceof ImplementAgentError) {
    console.error(error.message, error.outputTail)
  }
  throw error
}
```

State a field only where you disagree with what would be inferred:

```ts
await runImplementAgent({
  issueNumber: '123',
  issueTitle: 'Add pantry filter to recipe search',
  branch: 'agent/issue-123-pantry-filter',
  repo: 'galosandoval/recipe-chat-v1',
  claudeCodeOAuthToken: process.env.CLAUDE_CODE_OAUTH_TOKEN!,
  promptTemplate: fs.readFileSync('prompt.md', 'utf8'),
  standardsDir: '/tmp/skills/rules',
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
    // The caller's own app-specific env vars — this package bakes in none.
    requiredEnvVars: ['DATABASE_URL', 'OPENAI_API_KEY', 'GH_TOKEN']
  }
})
```

### Resolution order

Every optional input resolves the same way: **explicit input → environment
variable → probe (`git`, `gh`) → package default**. Probes are lazy — a field
you state, or one the environment already carries, never spawns a subprocess.

| Field | Environment | Probe | Default |
| --- | --- | --- | --- |
| `issueNumber` | `ISSUE_NUMBER` | — | *required* |
| `claudeCodeOAuthToken` | `CLAUDE_CODE_OAUTH_TOKEN` | — | *required* |
| `issueTitle` | `ISSUE_TITLE` | `gh issue view` | — |
| `branch` | `BRANCH`, `GITHUB_REF_NAME` | `git rev-parse` | — |
| `repo` | `GITHUB_REPOSITORY` | — | unset; `gh` then infers it from the checkout |
| `standardsDir` | `STANDARDS_DIR` | — | `''` (prompt skips the step) |
| `outputDir` | `OUTPUT_DIR` | — | OS tmpdir |
| `screenshotsDir` | `SCREENSHOTS_DIR` | — | `.agent/verify/issue-<N>` |
| `projectsDir` | `PROJECTS_DIR` | — | `~/.claude/projects` |
| `runPolicy.model` | `MODEL` | — | none — the Claude CLI's own default |
| `runPolicy.maxTurns` | `MAX_TURNS` | — | `150` |
| `runPolicy.idleMinutes` | `IDLE_MINUTES` | — | `15` |
| `runPolicy.wallClockMinutes` | `WALL_CLOCK_MINUTES` | — | none — the run has no wall-clock ceiling |
| `runPolicy.requiredEnvVars` | `REQUIRED_ENV_VARS` | — | `[]` |

`screenshotsDir` is deliberately **not** derived from `outputDir`: those files
get committed, so they stay repo-relative while the rest of the run's outputs
live in a temp dir.

`ANTHROPIC_API_KEY` is stripped from the child environment unconditionally,
however the OAuth token was resolved — inference never widens the auth surface.

`LOCAL_IDLE_MINUTES` / `LOCAL_WALL_CLOCK_MINUTES` override the guard budgets
for a single run without touching the contract.

#### Runaway guards

Two time-based guards watch a run, because they catch different failures. The
**idle guard** catches a *stalled* agent — output goes silent — and is always
armed, at 15 minutes by default. The **wall-clock guard** catches a *looping*
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

#### Not yet enforced

`runPolicy.cliVersion` (`CLI_VERSION`) is **recorded, not enforced**. Nothing
compares a running CLI against the pinned version. The field exists so that
enforcement can land additively; don't build a cost model on it.

### CLI

A thin bin entrypoint takes the issue number as its argument, for a drop-in
CI step:

```sh
CLAUDE_CODE_OAUTH_TOKEN=*** PROMPT_FILE=./prompt.md npx shopfloor-implement 123
```

Every environment variable in the table above works here too — the resolution
lives in the harness, not in this entrypoint. Inside GitHub Actions the
branch, repository, and commit come from the runner's own `GITHUB_*`
variables, so a workflow step restates none of them. A failed run writes its
reason to `failure_reason.txt` under `OUTPUT_DIR` and exits non-zero.

### Preflight refusal

Refuse a label-triggered run before it spends any tokens — a PRD (has native
sub-issues), a native sub-issue of a parent, or an issue that already has an
open PR targeting it:

```ts
import { runPreflight } from '@galosandoval/shopfloor'

const { verdict } = await runPreflight({
  issueNumber: '123',
  repo: 'galosandoval/recipe-chat-v1'
})
if (verdict.refused) {
  console.log(verdict.reason)
}
```

`evaluatePreflight` is the pure decision function underneath, if you already
have the sub-issue count / parent number / linking PRs gathered another way.

### Command guard

Three operations an autonomous run must never perform — pushing a Prisma
schema straight at the database instead of writing a migration, force-pushing,
and amending — are blocked at tool-call time rather than asked for in the
prompt. `runImplementAgent` arms this automatically: the invocation carries a
`--settings` payload wiring a `PreToolUse` hook over `Bash` at the shipped
hook script, and a matching command exits `2` with the reason and the
sanctioned alternative on stderr, which the CLI feeds back to the agent as a
refusal. It fires under `--dangerously-skip-permissions` too — that flag skips
the human prompt, not the hooks.

Nothing to configure, and nothing leaks into a human's own settings for the
same checkout: the payload is session-scoped, passed inline on the command
line. Prompts still say *why* the rules exist; enforcement no longer depends
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

`runImplementAgent` **refuses to start** if it can't find the hook script
beside its own bundle — a broken install fails the run rather than quietly
running it unguarded. The hook itself fails the other way on purpose: input it
can't read or classify exits 0, so the guard never takes a run down over a
command it has no opinion about.

### Verify-comment posting

Post the agent's verify-phase report and any committed screenshots back to
the PR as a comment:

```ts
import { postVerifyComment } from '@galosandoval/shopfloor'

await postVerifyComment({
  issueNumber: '123',
  verifyReportFile: '/tmp/out/verify_report.md',
  screenshotsDir: '.agent/verify/issue-123'
})
```

The repository comes from `GITHUB_REPOSITORY`, the commit the screenshots are
pinned to from `GITHUB_SHA`, the run link from `GITHUB_SERVER_URL` /
`GITHUB_RUN_ID`, and the PR from the head branch (`GITHUB_HEAD_REF`, else the
checkout) via `gh` — each overridable with `repo`, `sha`, `runUrl`, `prNumber`,
and `branch`. Outside Actions, `repo` and `sha` have nowhere to come from:
state them, or the comment goes unposted.

Best-effort by contract — it never throws, including when a value can't be
inferred; check the returned `posted` flag. `buildVerifyComment` is the pure
formatter underneath.

## Module layout

Organized by harness concern rather than a flat file list, so a future `plan`
or `review` module has an obvious home:

- `src/orchestration/` — `runImplementAgent` (the orchestrator),
  `resolveImplementConfig` (pure configuration resolution),
  `prepareClaudeInvocation` (pure CLI-invocation assembly), and `spawnClaude`
  (the subprocess, with both runaway guards armed around it).
- `src/guardrails/` — the run-policy contract (idle/wall-clock/max-turns
  resolvers), preflight refusal, the command policy and its `PreToolUse` hook
  script, and verify-comment posting (a feedback-loop guardrail: posting proof
  back to the PR).
- `src/observability/` — session transcript capture, for CI-artifact upload.

The package exports the four verbs (`runImplementAgent`, `runPreflight`,
`postVerifyComment`, plus `ImplementAgentError`), the three documented pure
escape hatches (`evaluatePreflight`, `buildVerifyComment`, `classifyCommand`),
`DEFAULT_RUN_POLICY`,
and the input/result types. The resolvers, the invocation assembler, and the
transcript helpers are internals — import from source if you're vendoring, but
they aren't API.

## Tests vs. evals

This package has **tests**: unit coverage on every pure function
(`evaluatePreflight`, `buildVerifyComment`, `classifyCommand`,
`resolveImplementConfig`, `prepareClaudeInvocation`, the run-policy resolvers,
transcript capture) that
asserts on inputs/outputs, no IO mocking. It does **not** have **evals** — no scored suite over labeled
trajectories or an LM-judge check of whether an actual agent run produced a
*good* implementation. The `implement` phase's best-effort Playwright verify
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
leaving "this doesn't release" to be inferred from silence. Merging to `main`
opens or updates a "Version Packages" PR; merging *that* bumps the version,
tags the commit, and publishes to npm with provenance via an OIDC trusted
publisher — there is no `NPM_TOKEN` in this repo.

## License

MIT
