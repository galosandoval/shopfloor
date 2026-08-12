# CONTEXT.md

Architecture and orientation for anyone — human or agent — changing this
package. [`CLAUDE.md`](./CLAUDE.md) holds the working rules;
[`README.md`](./README.md) is the consumer-facing API reference; this file is
the mental model behind both.

## What this is

This package **is the harness** for a GitHub-issue-driven SDLC loop —
orchestration logic, guardrails, and observability, but not the model. It shells
out to the `claude` and `gh` CLIs rather than wrapping an SDK, because the CLI
is the surface the loop is validated against. README's opening section has the
longer framing.

One phase ships today: `implement`. A `plan` phase and a `review` loop are
meant to land as further modules here — which is why the source is organized by
harness concern rather than as a flat file list.

## Module map

| Directory            | Owns                                                                                                                                                                                                                                                                                                   |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `src/orchestration/` | `runImplementAgent` (the orchestrator shell), `resolveImplementConfig` (pure config resolution), `prepareClaudeInvocation` (pure CLI-argument assembly), `spawnClaude` (the subprocess with both runaway guards armed), `ImplementAgentError`                                                          |
| `src/guardrails/`    | The run-policy contract and its resolvers (idle and wall-clock budgets, required env vars), the pure CLI-version comparison, preflight refusal, plugin-directory validation (`evaluatePluginDirs` / `runPluginDirsCheck`), the command policy and its `PreToolUse` hook script, verify-comment posting |
| `src/observability/` | Session transcript capture, for CI-artifact upload                                                                                                                                                                                                                                                     |
| `src/index.ts`       | The public surface — nothing else is API                                                                                                                                                                                                                                                               |
| `src/cli.ts`         | Thin bin entrypoint (`shopfloor-implement <issue>`); resolution lives in the harness, not here                                                                                                                                                                                                         |

## Pure core, IO shell

The structural convention every module here follows. A module that makes a
decision splits in two:

- **A pure function** — takes already-gathered facts, returns a verdict or a
  plan. No `fs`, no `child_process`, no `process.env`, no clock; an environment
  it needs arrives as a parameter (`resolveImplementConfig(input, env)`). Named
  `evaluate*` / `check*` / `classify*` / `resolve*` / `prepare*` / `build*`.
- **A thin shell** — runs the probes (`git`, `gh`, `claude --version`, `fs`),
  hands the raw results to the pure function, acts on the verdict. Named `run*`
  / `post*`.

The pairs: `evaluatePreflight` / `runPreflight`, `classifyCommand` /
`command-guard-hook`, `buildVerifyComment` / `postVerifyComment`,
`evaluatePluginDirs` / `runPluginDirsCheck`, `checkCliVersion` and
`resolveImplementConfig` / `runImplementAgent`.

A new module lands in that shape: name the decision, export it as a pure
function with its own input type, put it in `src/guardrails/` (a decision about
whether or how a run may proceed) or `src/orchestration/` (a decision about what
to run), and let the shell own every side effect. The shell should read gather →
decide → act, with the interesting logic in the middle function rather than
tangled through the IO.

Two payoffs, and both are why it's non-negotiable rather than stylistic: the
decision is testable without mocking anything (see
[`docs/testing.md`](./docs/testing.md)), and a guardrail's reasoning sits in one
readable function where it can be audited instead of spread across the IO that
happens to invoke it.

Optional inputs resolve exactly one way — explicit input → env var → probe →
default — inside the resolution layer (`src/orchestration/config.ts`,
`src/guardrails/run-policy.ts`), never scattered through the shells. Probes are
lazy: a field that was stated, or that the environment already carries, never
spawns a subprocess.

## The run, end to end

`runImplementAgent` is the whole flow, in order:

1. **Resolve config** — `resolveImplementConfig`, pure, over the caller's input
   and an env record.
2. **Verify preconditions** — first, and before any probe spends time or any
   token is spent: the caller's required env vars, that `standardsDir` resolves
   to a real directory, that every stated plugin directory is a plugin carrying
   skills and neither hooks nor MCP servers, and the running `claude --version`
   against the policy's pin. Returns the running version for the run result.
3. **Probe what's still unstated** — branch and issue title, via lazy `git` /
   `gh` calls in the shell. These run _after_ the preconditions, so a
   misconfigured run never pays for them.
4. **Assemble the invocation** — `prepareClaudeInvocation`, pure: flags (one
   `--plugin-dir` per validated plugin directory), the
   rendered prompt, and the inline `--settings` payload that arms the
   command-guard `PreToolUse` hook. Output always streams, because the idle
   guard reads the child's output as its heartbeat.
5. **Spawn** — `spawnClaude`, with the idle and wall-clock budgets armed. OAuth
   only; `ANTHROPIC_API_KEY` is stripped from the child env so a run can never
   fall through to a metered key.
6. **Capture the transcript**, best-effort, for the caller to upload.
7. **Check the result** — a runaway kill or non-zero exit fails the run; so does
   a run that committed nothing. A missing PR description falls back rather than
   discarding finished commits.

The caller owns everything outside the run: checking out the branch, opening the
PR, sandboxing, and any CI glue.

## Invariants worth knowing before you change something

- **Refuse early, cheaply.** A misconfigured run should fail before the spawn,
  naming the offending value. Preflight refusal exists for the same reason one
  level up: a PRD, a sub-issue, or an already-PR'd issue never starts.
- **Guardrails fail in the direction that costs least.** A missing command-guard
  hook script refuses the run — an unarmed guard on an autonomous run is worse
  than no run. The hook itself fails the other way: input it can't classify
  exits 0, so it never takes a run down over a command it has no opinion about.
  Same logic behind the CLI-version check warning by default: pin churn that
  fails green runs trains people to delete the check.
- **A plugin may add prose, never execution.** A stated plugin directory is
  refused if it ships hooks or MCP servers, from its manifest or from the
  convention directories alike. These runs pass
  `--dangerously-skip-permissions`, so permission declarations are moot; what
  is not moot is code that runs without the model choosing it, and tools the
  command guard cannot see — it matches shell commands only. This is also the
  tripwire on the merge loop of the plugin this package will later bundle: it
  fires the day an upstream change adds automatic execution, rather than that
  change arming silently in every consumer's run.
- **The two runaway guards catch different failures.** Idle catches a _stalled_
  agent; wall-clock catches a _looping_ one that stays chatty forever and is
  structurally immune to the idle guard. Neither substitutes for the other.
- **A wall-clock kill fails the run even if commits exist** — a run cut off
  mid-loop never reached its own verify phase, so the work is unvetted.
- **Probes are best-effort and lazy.** A probe that answers nothing becomes an
  error naming what to state instead, never a silent default.

## Standards in repo, procedures in skills

Where a piece of agent context lives is decided by one line: **standards are
per-repository and live in the repository; procedures are cross-repository and
arrive as skills.** This repository's coding standards are therefore files here
— [`docs/typescript-style.md`](./docs/typescript-style.md) and
[`docs/doc-comments.md`](./docs/doc-comments.md) — and multi-step procedures
(implement, review, TDD) stay out of the repo as installed skills.

Two failures forced the boundary, and both are why it should not be moved back:

- **The agent doing the work runs on a CI runner.** `CLAUDE.md` used to point at
  a skill by absolute path under the author's home directory — a symlink into a
  separate checkout on one laptop, and nothing at all anywhere else. A headless
  run was being handed a reference that did not exist.
- **The review sub-agent can only see repository files.** The `code-review`
  skill's Standards axis finds its sources by looking for documents _in the
  repository_ and hands that file list to a sub-agent with no other access. A
  skill loaded into the parent session is invisible to it. A standard living
  outside the repository cannot be reviewed against, by construction.

The converse holds too: a procedure duplicated into every repository drifts
between them, and it is the same procedure everywhere — so it belongs in one
installed skill, not in `CLAUDE.md`.

This is about work done _on_ this repository. The package still ships no
opinionated standards to its consumers; `standardsDir` points at theirs.

**Provenance, settled once so the files don't each carry it.** These documents
came from the author's `coding-standards` skill in
[galosandoval/skills](https://github.com/galosandoval/skills), a fork of
[mattpocock/skills](https://github.com/mattpocock/skills) (MIT, © Matt Pocock).
The fork's licence does not reach them: `git log` on the source files shows both
were written by this package's author, and neither contains upstream text. No
MIT notice is owed, and the copies here are edited to fit this repository rather
than kept diffable against the skill.

## Known gaps

[`docs/harness-gap-analysis.md`](./docs/harness-gap-analysis.md) is the standing
record: which structural holes were found, which are closed, and the reasoning
behind the guardrails that closed them. Read it before proposing a new one — the
argument has probably already been had. The largest gap still open is evals:
deterministic correctness of these functions is covered, but nothing scores
whether an actual agent run produced _good_ work.
