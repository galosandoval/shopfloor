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
  repo: 'galosandoval/recipe-chat-v1'
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
