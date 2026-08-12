# @galosandoval/shopfloor

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
