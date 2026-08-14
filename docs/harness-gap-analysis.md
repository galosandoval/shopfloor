# Harness gap analysis

**Date:** 2026-07-28
**Reviewed at commit:** `1ba11e6` (HEAD)
**Frame of reference:** _The New SDLC With Vibe Coding: From Ad-Hoc Prompting to
Agentic Engineering_ (Google, May 2026) — specifically §5 "Harness Engineering:
What Surrounds the Model", §3 "Context Engineering", and §2's tests-vs-evals
distinction.

Status: **resolved into issues.** A follow-up grilling session settled the open
questions; every finding below is now tracked. Sections retain their original
analysis, with decisions marked inline.

| Finding                                          | Issue                             |
| ------------------------------------------------ | --------------------------------- |
| §1 wall-clock guard                              | #4                                |
| §2 CLI version pin (+ standards-path validation) | #5                                |
| §4 release and versioning                        | #3                                |
| §5 skills / context ownership                    | #8 (closed by #24, #25, #26, #27) |
| CLAUDE.md for this repo                          | #6                                |
| recipe-chat-v1 upgrade                           | #7                                |

Two issues predate this doc and were authored from it: **#1** (shrink the
configuration surface) and **#2** (ship an agents directory). #1 is a prefactor
for #4 and #5 — it makes `wallClockMinutes` and `cliVersion` optional and settles
the config contract first. **#2 was closed** as superseded by the content-free
decision in §5. §3's remaining backlog (observability, feedback loop, hooks,
evals) is deliberately not yet filed.

---

## Summary

Two pieces of the run policy are documented, typed, and required of every
consumer, but never read at runtime — the wall-clock runaway guard and the CLI
version pin. Both are gaps between an advertised guarantee and actual behavior,
which makes them qualitatively different from the rest of the backlog: those are
things the harness doesn't do _yet_, these are things it says it does _now_.

Beyond those, the harness is missing most of what the paper places between the
model and the outcome: an outer feedback loop, in-run hooks, real observability,
evals, and any ownership of context.

### Consumer reality (established after the initial review)

The original analysis was written without checking who consumes this package.
Four facts that reframe several findings:

1. **The live consumer is `recipe-chat-v1`, not `recipe-chat`.** Its
   `agent/implement/*.ts` files are thin adapters importing `runImplementAgent`,
   `runPreflight`, `postVerifyComment`, and `ImplementAgentError` — not stale
   copies of them. This repo's README points at the wrong repository.
2. **The dependency is an exact pin, `"0.1.0"`, with no caret.** A new publish
   reaches that consumer only when it explicitly bumps. This de-risks every
   behavior change discussed below, and is why §4 settles on `0.x` rather than
   `1.0.0`.
3. **That consumer pins the Claude CLI by _installing_ it**, not by checking it —
   its workflow installs `@anthropic-ai/claude-code` at the pinned version. So in
   the only live pipeline, a version comparison is tautologically true. See §2's
   correction.
4. **`STANDARDS_DIR` points at a directory that does not exist.** It resolves to
   a `rules/` path inside the cloned skills repository, and that repository has no
   `rules/` path anywhere on its default branch — the standards moved when they
   became skills and the workflow was never updated. Every run has been
   instructing the agent to read an empty path, and the harness never validated
   it. This is the strongest single argument for §5.

---

## 1. The wall-clock guard does not exist

### What's there

| Piece                                 | Location                                        | State                |
| ------------------------------------- | ----------------------------------------------- | -------------------- |
| `wallClockMinutes` config field       | `src/guardrails/run-policy.ts:27`               | Required, documented |
| `WALL_CLOCK_MINUTES_ENV_VAR` override | `src/guardrails/run-policy.ts:15`               | Exported             |
| `resolveWallClockMs()`                | `src/guardrails/run-policy.ts:67`               | Implemented          |
| Unit tests for the resolver           | `src/guardrails/run-policy.test.ts:54,62,77,86` | Passing              |
| Public export                         | `src/index.ts:19`                               | Exported             |
| `WALL_CLOCK_MINUTES` required by CLI  | `src/cli.ts:49`                                 | Mandatory input      |
| Documented in README                  | `README.md:56,85,94`                            | Advertised           |
| **Call site in the actual run**       | —                                               | **None**             |

`runImplementAgent` resolves only the idle budget (`implement.ts:113`) and passes
only `idleMs` into `spawnClaude` (`implement.ts:125`). `spawnClaude`'s single
`setInterval` (`implement.ts:221`) compares against `lastActivity` and nothing
else. No elapsed-time deadline is ever computed or enforced.

Worth noting the resolver _is_ unit-tested — so the test suite is green and the
guard is absent. The tests cover the pure function in isolation; nothing asserts
it is wired into a run. That's the coverage shape that lets a gap like this
survive.

### Why it matters

The two guards catch different failure modes, and the one that exists is the
weaker of the pair:

- **Idle guard** catches a _stalled_ agent — output goes silent (hung tool call,
  deadlock, waiting on something that will never arrive).
- **Wall-clock guard** catches a _looping_ agent — one that stays productive-
  looking, emits output continuously, and never converges. Retry loops,
  thrashing on a failing test, re-reading the same files.

A looping agent resets `lastActivity` on every chunk and is structurally immune
to the idle guard. Right now the only backstops for that case are `--max-turns`
(inside Claude's own loop, not the harness's) and whatever timeout the
consumer's CI job happens to have. A consumer reading `README.md:85` reasonably
believes they have a 45-minute ceiling. They have neither the ceiling nor a
signal that it's missing.

Per the paper's §5 framing this is a guardrail-layer hole, and per §8 it's an
uncapped OpEx exposure — a looping agent burns tokens the whole time it loops.

### Open questions to settle before filing

1. **Timer mechanism.** Reuse the existing 15s `IDLE_CHECK_INTERVAL_MS` tick and
   check both budgets there (cheap, one timer, ≤15s granularity), or set an
   independent absolute deadline? Leaning toward the shared tick — the
   granularity is irrelevant at minute-scale budgets.
2. ~~**Kill signal.**~~ **DECIDED: `SIGTERM`, grace period, then `SIGKILL`.**
   The idle guard goes straight to `SIGKILL` (`implement.ts:225`); wall-clock
   will not. A looping agent is more likely than a stalled one to have real
   uncommitted work in progress, so it gets a chance to flush. Remaining
   sub-question: the grace period's length (leaning 30s) and whether the idle
   guard should adopt the same treatment for consistency — a stalled agent
   probably _can't_ respond to `SIGTERM`, so keeping the two different is
   defensible, but it should be a deliberate asymmetry with a comment, not an
   accident.
3. **Error discrimination.** `SpawnClaudeResult.idleKilled` is a boolean
   (`implement.ts:172`). Two guards need a reason discriminant so the thrown
   `ImplementAgentError` names _which_ budget tripped. Probably
   `killedBy: 'idle' | 'wall-clock' | null`. This is a breaking-ish shape change
   to an internal type only — `ImplementAgentError`'s public surface is unchanged.
4. **Interaction with the zero-commit check.** A guard trip currently throws at
   `implement.ts:134`, before the `commitsAhead` check at `:150`. If a
   wall-clock kill happens _after_ the agent made good commits, is that still a
   hard failure? Current behavior says yes. Is that right, or should a killed-
   but-committed run be surfaced differently (a distinct result state, or a
   PR marked for human triage)?
5. **Does the override env var need to work the same way?** `LOCAL_WALL_CLOCK_MINUTES`
   is already documented as functional. It'll start working for the first time
   as a side effect of this fix — no separate work, but worth calling out in the
   changelog so nobody reads it as a behavior change they didn't ask for.

### Rough shape of the fix

Small. Resolve `wallClockMs` alongside `idleMs` in `runImplementAgent`, thread
it into `spawnClaude`, record `startedAt` before `spawn`, and extend the existing
interval callback to check both. Widen the kill-reason type and the two error
messages. Add a test that asserts wiring, not just resolution — the missing test
is arguably the more important half of this issue.

---

## 2. The CLI version pin is inert

### What's there

`RunPolicyConfig.cliVersion` (`src/guardrails/run-policy.ts:23`) is documented as
"pinned Claude Code CLI version this run policy was validated against."
`src/cli.ts:47` makes `CLI_VERSION` a required env var — a run refuses to start
without it. `README.md:54,83` show it as `2.1.208`.

It is read in exactly those two places and compared to nothing. No `claude
--version` call exists anywhere in the package. The harness runs against
whatever `claude` resolves on `PATH`.

### Why it matters

The drift is already real, not hypothetical. On this machine today:

```
$ claude --version
2.1.220 (Claude Code)
```

against a documented pin of `2.1.208` — 12 patch versions of drift, silently.

> **Correction.** That measurement was taken on a developer laptop, not in CI, and
> it overstates the finding. The live consumer's workflow _installs_ the pinned
> CLI version before running, so in that pipeline the running version equals the
> pin by construction and a comparison would always pass. The real value of this
> check is narrower than first written: consumers who don't install-pin, and local
> runs. Issue #5 states the reduced scope. The finding stands — an unvalidated pin
> is still a documented guarantee that nothing enforces — but it is a smaller win
> than the drift number implied, and it should be sequenced accordingly.

The harness depends on CLI surface that can move underneath it: the
`--print` / `--output-format stream-json` / `--include-partial-messages` /
`--dangerously-skip-permissions` flag vector (`claude-invocation.ts:63-80`), the
stream-json event shape, and the `~/.claude/projects/**/*.jsonl` session layout
that `findNewestSessionFile` walks (`observability/transcript.ts`). A CLI change
to any of those degrades or breaks a run, and the failure surfaces as a confusing
downstream symptom (empty transcript, unparseable output, a flag error buried in
`outputTail`) rather than as "your pin doesn't match."

The cost of _not_ checking is highest precisely where this harness runs: an
unattended CI job with no human to notice the version moved.

### Open questions to settle before filing

1. ~~**Hard fail, or warn?**~~ **DECIDED: warn by default, opt-in strict.**
   An exact-match pin would mean every upstream Claude Code release breaks every
   consumer's pipeline until they bump a constant — a support burden that trains
   people to loosen or delete the check. Default behavior is therefore: observe
   the running version, record it, and warn loudly on mismatch without blocking.
   Consumers who need reproducibility opt into hard-fail. The diagnostic value —
   knowing which CLI produced a given run — is most of the win and costs nothing
   in reliability.

   Remaining sub-questions: what the opt-in looks like (a `strictCliVersion:
boolean`, or a `'warn' | 'error' | 'off'` enum — leaning the enum, since
   `'off'` is a real need for local dev), and what strict mode compares
   (exact match vs. `>=` vs. same major.minor).

2. **Is this a guardrail or observability?** Now that the default is
   non-blocking, it's mostly a _record_ — which argues for the observed version
   living in `src/observability/` run metadata, with only the optional
   comparison in `src/guardrails/`. Splitting it that way keeps the directory
   semantics honest and feeds §3.3 directly. Needs a call before filing.
3. **Should `cliVersion` become optional?** Yes, following from Q1 — it's
   currently required by the CLI entrypoint for a check that doesn't run.
   `undefined` should mean "don't compare, just record." Note this makes
   `CLI_VERSION` non-mandatory in `src/cli.ts:47`, which is a small breaking
   change to the CLI contract in the _lenient_ direction (previously-valid
   invocations stay valid).
4. **Where does the check run?** Alongside `findMissingEnvVars`
   (`implement.ts:81`) — before the spawn, so a mismatch costs zero tokens.
   Consistent with the existing fail-fast-before-spending principle already
   stated in that comment.
5. **Parse robustness.** Observed output is `2.1.220 (Claude Code)` — needs a
   tolerant parse (leading semver, ignore the suffix) and a defined behavior for
   when `claude --version` fails or returns something unrecognized. Almost
   certainly: don't block the run on an unparseable version string.

### Rough shape of the fix

Also small, once Q1 is answered. A `resolveCliVersion()` / `checkCliVersion()`
pair — pure comparison function plus a thin `execFile` wrapper, matching the
`preflight.ts` / `run-preflight.ts` split the package already uses for exactly
this pure-core-plus-IO-shell shape.

---

## 3. Backlog — structural gaps

Captured at lower resolution. Each needs its own drill-down before filing.

### 3.1 No feedback loop (highest value)

The paper (§5.3) puts this at the center of what a harness _is_: "orchestration
logic captures failures and routes them back to the model for retry — this is
what creates the automated think → act → observe loop."

Shopfloor is single-shot. Spawn, wait, check. The only post-run assertion is
`commitsAhead !== 0` (`implement.ts:150`) — _did it commit anything_, not _is it
correct_. The harness never runs the consumer's tests, typecheck, or lint after
the agent finishes; it trusts the prompt to have done so, and the prompt is
per-consumer and explicitly not owned by this package (`README.md:17-21`). A run
that commits a broken build is indistinguishable from a green one.

`maxTurns` is Claude's inner loop. There is no outer loop.

### 3.2 No hooks / in-run guardrails

The paper calls hooks "the place for things the agent should never forget but
often does" — deterministic code at lifecycle points (before a tool call, after
an edit, before a commit).

This harness has a pre-run gate (preflight) and a post-run gate (verify comment)
and nothing in between. No `PreToolUse` blocking, no pre-commit secret scan, no
post-edit format. Claude Code supports hooks natively via settings; shopfloor
ships none and never writes a settings file for the child process. Combined with
`--dangerously-skip-permissions` (`claude-invocation.ts:71`) and no
`--allowedTools`/`--disallowedTools`, the in-run guardrail layer is empty —
containment is entirely delegated to "the caller runs this in a disposable
runner."

### 3.3 Observability is a file copy

`captureTranscript` copies the newest JSONL and returns a boolean. Nothing parses
it.

Meanwhile the run already emits `stream-json` with `--include-partial-messages`
(`claude-invocation.ts:76`) — structured trajectory, tool calls, usage — and that
stream is written to stdout (`implement.ts:207-217`) and dropped. So the harness
has none of what §5 lists as the observability layer: no token or cost metering,
no latency, no tool-call counts, no turn count, no drift signal. On a flat-rate
OAuth token, cost is invisible by construction, which makes the paper's entire §8
token-economy argument unmeasurable here.

**This is the highest-leverage add relative to effort — the data already flows
through the process.** It's also a prerequisite for 3.4.

### 3.4 No evals

Already named honestly in `README.md:152-162`, and that honesty should stay. But
note where it places the project on the paper's §2 spectrum: tests + evals
_together_ are the stated mechanism, and without both "it's still vibe coding no
matter how sophisticated the prompts are."

Every test in this repo covers the harness's own pure functions. Nothing scores
what the agent produced. There's no trajectory evaluation either — which §4
argues matters more than output evaluation ("a fluent output that skipped
verification steps is more dangerous than one with a visible error") — and the
trajectory data that would enable it is currently discarded (see 3.3).

### 3.5 No memory, no context ownership

The paper's six context types map onto this harness as: guardrails partially,
tools not at all, and instructions/knowledge/memory/examples entirely delegated
to the consumer's `promptTemplate` plus a bare `standardsDir` string.

Every run starts cold. A failed run teaches the next one nothing. There is no
static/dynamic context boundary to review or version — §3 calls that boundary "a
first-class architectural decision" — because the package holds no context at
all.

Defensible as a v0.1 scope decision, but it means what ships today is closer to
_process supervision_ than to the "Agent = Model + Harness" claim at
`README.md:8`. Most of the 90% the paper attributes to the harness lives in files
this package doesn't ship.

**Partially addressed by §5 / #8** (shipped as #24–#27), which took on the
instructions layer and moved knowledge to partial. Memory, examples, and tools
remain at zero.

### 3.6 Smaller items

- **No model routing.** One `model` for planning and mechanical work alike;
  §8 argues for routing cheap models to deterministic work.
- **Trunk is hardcoded.** `git rev-list --count main..HEAD`
  (`implement.ts:150`) assumes `main`.
- **No timeouts or retries on `gh`.** A transient GitHub blip fails preflight
  (`run-preflight.ts`) or silently swallows the verify comment
  (`post-verify.ts` catches and returns `posted: false`).

---

## 4. Release and versioning has no mechanism

Distinct from §1–§3: this is a gap in the repo's own process, not in the harness
it ships. Raised because both §1 and §2 change `RunPolicyConfig`'s contract, so
it becomes load-bearing the moment those land.

### Current state — not an error today

| Fact                   | Value                                                           |
| ---------------------- | --------------------------------------------------------------- |
| `package.json` version | `0.1.0` (`package.json:3`)                                      |
| Published on npm       | `0.1.0`, at `2026-07-25T03:28Z`                                 |
| Git tags               | none                                                            |
| Changelog              | none                                                            |
| Release workflow       | none — `ci.yml` runs lint/typecheck/test/build, never publishes |

npm and git currently _agree_. The publish happened ~1 hour after commit
`001c55c`, and the only commit since (`1ba11e6`, three days later) touched
`publishConfig` alone — no `src/` drift. But that's circumstance, not a
guarantee, and establishing it required inferring provenance from timestamps.

### Four holes

1. **No tags.** Nothing in git records which commit produced `0.1.0`. For a
   package whose value proposition is auditability of agent runs, being unable
   to answer "which commit is running in CI?" is thematically wrong.
2. **The next publish is already blocked.** `package.json` says `0.1.0` and
   `0.1.0` is taken; `npm publish` will 403 ("cannot publish over previously
   published version") until someone remembers to bump. Nothing surfaces this
   until it fails.
3. **Publishing is manual and unverified.** The npm artifact was built from a
   laptop working tree, not a clean CI checkout. `prepublishOnly: npm run build`
   rebuilds but proves nothing about tree cleanliness or test status.
4. **No changelog.** See below for why that bites immediately.

### Why §1 makes this urgent

The wall-clock fix changes _behavior without changing a type_. A consumer whose
runs quietly went three hours will start dying at 45 minutes, and `tsc` will
report nothing. That is precisely the class of change a changelog exists for,
and there is no channel to communicate it.

§2 is milder — optional `cliVersion` plus a strictness setting is additive, and
the `cli.ts` change only widens what's accepted.

### Decisions — settled, tracked as #3

Make it a deterministic gate rather than a discipline — the same argument §3.2
makes about hooks ("things you should never forget but often do").

- **Changesets**, not a CI version-collision floor. The floor was considered as a
  five-line stopgap and dropped: Changesets subsumes it, so building both is
  waste.
- **One consolidated `release.yml`, replacing `ci.yml`.** A `verify` job on both
  `pull_request` and push-to-main, and a `release` job with `needs: verify`
  gated to main. The `needs` edge is the point — two independent workflows on the
  same trigger would race, and a publish could beat a failing test suite. This
  also removes the duplicate-checks objection to running tests before publish.
- **The filename is load-bearing:** the npm trusted publisher is configured
  against `release.yml` specifically.
- **Auth is OIDC trusted publishing — no `NPM_TOKEN` at all.** Provenance comes
  automatically, which is the actual fix for hole #1: the commit behind a publish
  becomes cryptographically attested rather than merely documented. Publishing
  access was also tightened to disallow bypass-2FA tokens, so the only paths to
  the registry are the workflow and a human with an OTP.
- **OIDC requires npm >= 11.5.1**, which neither node 20 nor node 22 bundles, so
  the release job installs npm explicitly. Skipping this fails authentication
  with an error that doesn't point at the npm version.
- **PR-time changeset enforcement, with an explicit empty changeset** as the
  escape hatch for non-shipping PRs. Chosen over path-filtering and over
  bot-reminder-only because it is the one option where "this doesn't ship" is
  _recorded_ rather than inferred from silence — and it degrades correctly with
  agents, which get an actionable red check rather than a silent no-release.
- **Stay `0.x`; the wall-clock guard ships as `0.2.0`.** The consumer's exact pin
  already provides what `1.0.0` would buy. Accepted trade: a behavior break lands
  as a minor, with the changelog as the only warning. See the caveat below.
- **Backfill an annotated `v0.1.0` tag** whose message states it was reconstructed
  from publish timestamps rather than recorded at release time — honest about the
  one entry whose provenance is inferred.

**Explicitly rejected: semantic-release / conventional-commits.** It derives
version bumps from commit-message phrasing, and this repo's entire purpose is
agents writing commits. Version numbers decided by an LLM's choice of prefix is
a failure mode that would be built in deliberately. An explicit changeset file
is robust to agent-authored commits in a way that message parsing is not.

> **The `0.x` decision may not survive §5.** Replacing `standardsDir` is a
> breaking config change, and #1 carries breaking changes of its own. Two
> breaking releases inside `0.x` within weeks is weaker signal than one
> `1.0.0`. Revisit when #8 is grilled.

---

## 5. Context is delegated through a string that rots

Deepens §3.5 with a concrete failure, and supersedes the closed #2. Tracked as
**#8**, and **closed** by #24, #25, #26, and #27 — see "What was built" below,
which records what shipped and what it deliberately did not close.

### The failure

`standardsDir` is a bare path substituted into the prompt template. The harness
never validates it, never installs anything, and never uses Claude Code's own
skill discovery. That contract has already rotted: the live consumer's path
resolves to a directory that does not exist (see Consumer reality, fact 4), and
nothing anywhere reported it. A wrong path and a right path are indistinguishable
to this package.

So the "context" half of the harness is not merely thin — it is unverified.

### Direction — agreed

**shopfloor stays content-free.** It ships the wiring, not the skills. Skill
content already lives in its own repository, which is already a Claude Code
plugin with its own release process; duplicating it here would make shopfloor a
framework rather than a harness and reverse its stated position on baking in
opinions. This is also why #2 was closed — it shipped a default prompt on the
explicit grounds of "deliberately reverses a stated scope decision."

The mechanics proposed at the time — take a skills source as config, stage into
a temp directory laid out as `<staged>/.claude/skills/<name>/`, pass it to the
CLI as an additional directory, refuse if it resolves to zero skills — were
**rejected during grilling** and are restated here only so the argument against
them survives for whoever proposes them again; "What was built" below carries
that argument.

### Documented behavior this relies on

From `code.claude.com/docs/en/skills`:

- Skills live at `~/.claude/skills/<name>/SKILL.md` (personal),
  `.claude/skills/<name>/SKILL.md` (project), or `<plugin>/skills/<name>/SKILL.md`
  (plugin). Precedence: enterprise > personal > project; plugin skills are
  namespaced and cannot collide.
- **An added directory's `.claude/skills/` is loaded** — called out as a
  deliberate exception to additional directories otherwise granting file access
  only. This is what makes staging work without touching the consumer's repo.
- Symlinks are supported at personal and project level, and are de-duplicated when
  the same target is reachable twice.
- A project skill's `allowed-tools` can grant broad tool access, gated on the
  workspace trust dialog. These runs already pass
  `--dangerously-skip-permissions`, so whatever ships skills is inside the trust
  boundary — an unresolved security question, listed in #8.

### Interim mitigation

#5 added validation rather than waiting on this: an empty `standardsDir` still
meant "deliberately skip," while a non-empty value resolving to nothing failed
before the CLI spawned. Stricter than #5's CLI-version warn, because a dead
standards path silently changes what the agent produces. It was expected to be
made moot by the deletion below; it was not, quite — see the refusal #27 put in
its place.

### What was built — #24, #25, #26, #27

**Skills reach the agent through the CLI's own plugin discovery, not through a
staged directory.** `pluginDirs` (`PLUGIN_DIRS`) passes each entry as its own
`--plugin-dir`, session-scoped, validated before the spawn (#25); an unstated
list loads the bundled `galosandoval/skills` plugin, installed as a tagged git
dependency (#26); a stated list replaces that default rather than adding to it.
`standardsDir` and its prompt placeholder are gone (#27), and this repository's
own standards moved into this repository as ordinary docs (#24) rather than
becoming something to ship.

**Why staging into a synthesised `.claude/skills/` layout was dropped.** It was
a second, independent model of how the CLI discovers skills — one that would
drift from the real one, silently, in exactly the way the bare path it replaced
did. `--plugin-dir` is the CLI's own supported entry point, so the harness
asserts only what a plugin manifest asserts about itself and lets the CLI do
discovery. Staging also bought a temp-directory lifecycle, a copy step, and a
name-collision policy the plugin namespace already settles. The one thing
staging was for — keeping files out of the consumer's git tree, since the agent
commits its own work — `--plugin-dir` gives for free.

**Removal had to fail loudly.** Deleting `standardsDir` alone would have left a
consumer's CI-set `STANDARDS_DIR` meaning nothing: no type error, no runtime
error, a run quietly poorer in context than its operator believed. So a stated
value or a non-empty variable refuses before the spawn, naming the replacement;
an empty one still means "deliberately skip". The field is therefore removed
from the public type and still read at runtime, on purpose, with a note at the
declaration saying so. A deprecation window where both paths worked was
rejected: it means precedence logic in the resolver whose only purpose is to be
deleted later.

**What this does not close.** Of the paper's six context types (§3.5), this
moves **instructions** from delegated to shipped, and **knowledge** from absent
to partial — the bundled skills carry procedure, not the consumer's domain.
**Memory**, **examples**, and **tools** remain at zero: every run still starts
cold and a failed run still teaches the next one nothing. **Evals** (§3.4) —
scoring whether a run produced good work, and whether it took a sound path to
get there — remain the largest open gap, and nothing here touches them.
"Native skills wiring" closed the context-by-rotting-string failure; it did not
close context ownership.

---

## Suggested sequencing

The filed order, blockers first:

1. **#3 — Changesets release pipeline.** No blockers. Goes first because after it
   every PR needs a changeset to pass CI, which makes it a prerequisite for
   everything else including the pre-existing #1.
2. **#1 — shrink the configuration surface.** A prefactor: it makes
   `wallClockMinutes` and `cliVersion` optional and settles the config contract,
   so the enforcement work lands against a stable shape instead of moving it
   twice. Needs a changeset once #3 lands.
3. **#4 — wall-clock guard** and **#5 — pre-spawn precondition checks.** Both
   blocked by #3 and #1. #4 is the higher-value of the two; #5 shrank once the
   install-pin correction landed and could reasonably wait.
4. **#6 — CLAUDE.md.** Blocked by #3, because it documents the changeset workflow
   and shouldn't describe something that doesn't exist yet.
5. **#7 — recipe-chat-v1 upgrade.** Blocked by #4. Until this lands the wall-clock
   guard runs in no live pipeline — the difference between shipped and released.
6. **#8 — skills wiring.** Blocked by #1. Grilled, then split into #24 (standards
   into this repo), #25 (`pluginDirs`), #26 (bundled plugin), and #27 (remove
   `standardsDir`). All landed; see §5's "What was built".

Still unfiled, in the order they're worth doing:

- **§3.3 observability** — the highest leverage remaining. The stream-json
  trajectory already flows through the process and is discarded; parsing it
  unlocks cost telemetry and the trajectory records §3.4 needs. #5's "record the
  observed CLI version" is a natural seam into it.
- **§3.1 feedback loop** — what turns this from a spawner into a factory in the
  paper's sense.
- **§3.2 hooks**, **§3.4 evals**, and §3.6's smaller items.
