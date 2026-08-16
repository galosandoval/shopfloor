# The SDLC loop — settled design

**Date:** 2026-08-14
**Reviewed at commit:** `6c88a8a` (HEAD, `development`)
**Frame of reference:** [`docs/harness-gap-analysis.md`](./harness-gap-analysis.md)
§3.1 (no feedback loop), §3.3 (observability), §3.5 (no memory, no context
ownership), and _The New SDLC With Vibe Coding_ §3 (context types), §4 (the
SDLC phases), §5 (harness anatomy).

Status: **settled, unbuilt, and reviewed.** Twenty-four decisions taken in one
grilling session. Nothing here is implemented; this document is the record to
file issues from. One item was left open by the session — see
[Residual](#residual) — and a later review found seven more, plus one decision
this document should reverse: see
[Review — open flaws](#review--open-flaws-2026-08-14).

This supersedes nothing in the gap analysis. It covers the layer that document
never examined: the **trigger and state layer** around a run, rather than the
run itself.

---

## Why this exists

The gap analysis audited what happens between spawn and exit. It never looked at
what happens before and after — which, in the only live consumer, is 323 lines of
GitHub Actions YAML. Two facts from that file forced this session:

1. **The boundary was already crossed, silently.**
   `src/guardrails/run-preflight.ts:83-105` runs
   `gh issue edit --remove-label 'agent:implement' --add-label 'agent:blocked'`
   and posts a comment. Both label names are **string literals in the package**.
   So shopfloor already owned one issue-state transition and already shipped a
   consumer vocabulary, while [`CLAUDE.md`](../CLAUDE.md) listed consumer names
   under what the package does not own.

2. **The bash layer was already rotting, provably.** `gh label list` on
   `recipe-chat-v1` returns `ready-for-agent`, `agent:implement`,
   `agent:blocked`, `agent:in-progress`. There is **no `ready-for-human`
   label**. The workflow's "swap ready-for-agent for ready-for-human" step has
   therefore failed on every successful run since it was written, swallowed by
   `|| true`. A transition the pipeline claims to make has never once happened.

Fact 2 is the argument for the whole design. It is the `standardsDir` failure —
an untyped string binding that rots invisibly — reproduced in the layer nobody
had audited. Ratifying and generalizing the boundary was chosen over reverting
it because reverting sends the state machine back to the layer that just
demonstrated it cannot hold one.

---

## 1. The two loops

The single most important structural decision, and the one that arrived last.
**There are two feedback loops, distinguished by whether the harness can
generate the signal before it exits.**

|               | Inner loop                                                                 | Outer loop                                                                                            |
| ------------- | -------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| Mechanism     | `while` in TypeScript, one process, repeated CLI spawns                    | GitHub event triggers an entirely new run                                                             |
| Signal        | anything the harness produces itself — quality gate, typecheck, tests, e2e | anything that exists only after the PR does — required checks, deploy previews, human review          |
| Cost per turn | one CLI spawn                                                              | full runner setup (recipe-chat-v1: install + generate + migrate + seed + playwright ≈ 3–5 min billed) |
| Counter       | a loop variable                                                            | derived (§4)                                                                                          |
| Bound         | its own budget in `runPolicy`                                              | the attempt ceiling in `runPolicy` (§4)                                                               |
| Concurrency   | impossible by construction                                                 | a real hazard (§7)                                                                                    |
| Attribution   | not needed                                                                 | required (§6)                                                                                         |

**The rule: catch it in-process if the harness can generate the signal itself;
use the event loop only when the signal arrives after exit.**

This matters for sequencing and for cost. The inner loop is cheap, has no
GitHub plumbing, needs no PAT, and is where the large majority of failures
should be caught. The outer loop exists for signals that structurally cannot be
caught in-process — `workflow_run.completed` arrives after the runner is
destroyed, so there is no `while` still alive to receive it.

Everything in §4, §6, and §7 below is **outer-loop-only**. The inner loop needs
none of it.

Both together are what the paper's §5.3 calls the definition of a harness:
"orchestration logic captures failures and routes them back to the model for
retry." Today shopfloor is single-shot; `maxTurns` is Claude's inner loop, and
there is no outer one at either scale.

---

## 2. One verb

The public surface collapses. Today: `runImplementAgent`, `runPreflight`,
`postVerifyComment`, `runPluginDirsCheck`, plus four pure escape hatches, with
the sequencing between them living in consumer YAML. After: **one verb,
`runPhase(rawEvent)`**, which classifies, authorizes, admits, runs, reports, and
transitions state.

The verb count was never the interface — the **sequencing knowledge** was, and
it currently lives where it can be neither typed nor tested.

**What this costs, named.** The current two-job split exists so a refused run
pays no runner setup. Under one verb, a refusal pays for `bun install`, Prisma
generate, and Playwright. That is roughly a minute of CI, weighed against a
state machine that today spans 323 lines of bash, three `|| true` blocks, and
one transition that has never fired.

The pure escape hatches survive unchanged — they are decision functions, not
sequencing.

### The trigger boundary

The consumer passes the **raw webhook payload** (`$GITHUB_EVENT_PATH`
contents). A pure `classifyTrigger(payload)` derives phase, issue number, actor,
and authorization.

Rejected: discrete destructured fields (what the current workflow does, and why
trigger logic is smeared across `if:` expressions and `env:` blocks), and a
provider-neutral `SdlcEvent` type. The latter is tempting and wrong for the same
reason skill-staging was wrong: this package shells out to `gh` everywhere and
validates against the GitHub CLI's surface, so a neutral event type would be an
abstraction over exactly one provider — a second model of something already
depended on directly.

### Branch and PR ownership

The verb owns **both**, forced by the outer loop. A retrigger lands on a branch
that already exists with a PR already open, so the harness must find and reuse
both to iterate at all. Something that must be located on every loop edge is
already owned; leaving creation outside means two components computing the same
branch identity — and §6's attribution rule already declined to depend on the
consumer's slug convention for exactly that reason.

This replaces a `tr`/`sed`/`cut` slug pipeline and a `gh pr create` invocation
in consumer YAML.

---

## 3. Which events

Admission criterion: **trigger-shaped** — a phase is in scope if it is an event
that starts an agent run and ends in a GitHub state change.

v1 edges:

| Edge                                             | Kind    | Role                     |
| ------------------------------------------------ | ------- | ------------------------ |
| `issues.labeled`                                 | human   | entry — starts the loop  |
| `workflow_run.completed` (`conclusion: failure`) | machine | closure — the outer loop |

The machine edge is what makes it a loop rather than a fan of triggers: it is
the only one with no human on it, and the paper's automated think→act→observe
requires that. `workflow_run` over `check_suite` because it names the workflow
and yields a run id for logs.

**Deferred, deliberately:** `issue_comment.created` (human steering) and
`pull_request_review_comment` / `pull_request_review` (review feedback). Both
are valuable and both need their own instruction-extraction design — what does a
comment _mean_, which comment, threaded replies — that the machine edge does not.

**Rejected by the criterion**, and recorded so the omission reads as a decision:
the paper's §4 phases **Design & Architecture** (no discrete trigger; the paper
itself calls it the most human-centric phase), **Deployment** (not agent-run
shaped), and **Maintenance & Evolution** (a mode, not an event). The table
reaches four of the paper's six phases. That is the criterion working, not the
criterion failing.

### Authorization

The only guardrail in the system whose failure mode is **financial and
adversarial** rather than operational. Today it is one line of unquoted YAML —
`github.actor == 'galosandoval'` — with no test anywhere, protecting a
maintainer's subscription on a public repo. Every other guardrail in this
package got a pure function and a test suite.

It becomes a live probe: `gh api repos/{repo}/collaborators/{user}/permission`,
**refusing on uncertainty**.

That inverts the package's stated "guardrails fail in the direction that costs
least." Everywhere else — CLI version, transcript, verify comment — an
unreadable signal proceeds, because a missing diagnostic should not cause an
outage. Here an unreadable signal means "I do not know whether this person may
spend your money," and proceeding is the expensive direction. **This is the
first guard in the package that refuses on uncertainty, and it is deliberate.**

---

## 4. Bounding the outer loop

A stateless event loop has no natural termination: agent pushes → CI red →
retrigger → pushes → CI red, forever. Something must count.

**The count is derived, never stored** — `gh run list --branch`. This is the
third runaway guard, and it belongs in `runPolicy` beside `idleMinutes` and
`wallClockMinutes`:

- **idle** catches a stalled agent
- **wall-clock** catches an agent looping _within_ a run
- **attempt ceiling** catches an agent looping _across_ runs

Today the third is uncapped, which makes the most expensive failure mode in the
system the only one with no guard.

**Why derived.** The same argument that settled `--plugin-dir` over skill
staging: do not build a second model of state you can read from the real one. A
label or a comment is state the harness writes and must then keep consistent
across `always()` clears, concurrent runs, and human edits — three ways to
desync.

**Why not count handoff files.** Counting `.agent/attempts/*` counts _completed_
attempts. A run killed by the wall-clock guard, or one that crashes before
writing its handoff, leaves no file — so a file count undercounts on exactly the
runs the ceiling exists to stop. The guard would be blindest against the
failure mode it was built for.

### Terminal state

The ceiling trips into a **distinct** state: `agent:exhausted`, not
`agent:blocked`, **plus the accumulated handoff trail posted as the comment**.

Preflight-blocked and exhausted are the two failures with the most different
human responses in the system — _fix the issue's shape_ versus _the work is
harder than specified, or the spec is wrong_. Collapsing them discards the most
expensive signal the harness produces. The handoff trail is posted because it is
already written and is already the best account of what went wrong; the
alternative is a human opening N commits to reconstruct it.

The PR stays open. Closing it discards partial work, and the paper's 80% problem
says attempt N usually got most of the way.

---

## 5. Memory — the handoff artifact

The gap analysis named this twice as unclosed: §3.5 and §5's "What this does not
close" — _"**Memory**, **examples**, and **tools** remain at zero: every run
still starts cold and a failed run still teaches the next one nothing."_ This is
the paper's §3 memory context type.

**It is load-bearing for the outer loop, not a nicety.** Without a handoff,
iteration N+1 starts cold, re-derives the same wrong approach, and fails
identically. A bounded loop over identical attempts is not a feedback loop; it
is a token incinerator with a stop button.

### Authorship — both, in labeled sections

- **Harness-authored (load-bearing):** the CI failure that triggered the edge,
  the trajectory scorecard's findings, the attempt's run id, the diff.
- **Agent-authored (marked as _claims_):** what it tried, what it abandoned, what
  it believes the root cause is.

Never blended. The next iteration must be able to tell "CI said X" from "the
last agent believed X."

Pure agent-authorship fails in a way the paper names in §4: _"a fluent output
that skipped verification steps is more dangerous than one with a visible
error."_ An agent that just failed is the least reliable narrator of why — a
self-authored postmortem is exactly that fluent-but-wrong artifact. Pure
harness-authorship throws away the one thing only the agent knows, and that is
unrecoverable from the transcript at any reasonable cost.

### Storage — committed to the branch

`.agent/attempts/<run-id>.md`.

This **deliberately breaks the derive-don't-store rule** §4 just set, and the
distinction is the justification: the run count is a _fact_ and gets derived;
the handoff is a _synthesis_ and cannot be re-derived deterministically —
re-deriving would mean re-summarizing the same failure into different prose
every iteration.

Named by run id, not a sequence number: once the bound is derived from attempts
(§4), a sequence number has no job left except to disagree with the real count.
The run id also links straight back to the logs and transcript that produced it.

The lifecycle precedent already exists in the pipeline — verify screenshots
commit to the branch, get consumed, and are stripped by a follow-up commit while
the PR comment stays pinned to the original SHA.

### Read and strip

- **Read:** a `{{ATTEMPTS_DIR}}` path placeholder; the agent reads what it needs
  for itself. Not inlined — inlining costs context linearly in attempt count and
  puts the whole trail in _static_ context. The paper §3 calls the static/dynamic
  boundary "a first-class architectural decision," and N failed attempts is the
  textbook case for dynamic.
- **Strip:** all of them on success, at the same point verify screenshots are
  stripped. Kept on `agent:exhausted` — the PR stays open and §4 wants them.
- **Not** one-at-a-time: attempt 3 learning only from attempt 2 is how a loop
  oscillates between two wrong approaches.

### CI failure content

A **bounded tail** of `gh run view --log-failed`, plus the run URL. A fetch
failure degrades to URL-only rather than blocking the loop, matching how every
other observability path in this package fails.

URL-only would make the loop blind on its only automated edge — the next agent's
entire advantage is knowing what broke without re-running anything. Unbounded is
how a handoff file becomes the context rot the paper §3 warns about, one
iteration at a time.

---

## 6. Attribution — which CI failures are ours

Most CI red in a repository has nothing to do with an agent. The machine edge
needs a rule, and mis-attribution is expensive: it spawns an unrequested,
fully-permissioned run against someone else's branch.

**Commit authorship** (`claude-code[bot]` on the head commit), with the
`agent/issue-*` **branch prefix as a cheap pre-filter**.

Authorship over branch naming as the _decisive_ test because branch naming is a
convention generated by a `sed` pipeline in consumer YAML — under §2 the harness
now generates it, but keying the loop on a name is keying it on something a
consumer can change, while the git identity is set by the harness itself and is
readable straight off the payload.

---

## 7. Concurrency

The machine edge makes this a live hazard rather than a theoretical one: a CI
failure can land while a run is still in flight.

**Derived, from the same `gh run list` call the ceiling already makes.** One
call on the critical path answers both "how many attempts" and "is one in
flight."

Rejected: the `agent:in-progress` label as a lock. It looks natural now that
labels are harness-owned, but it puts a **spend lock in mutable, human-editable
state** — a maintainer clearing a stuck label by hand would silently unlock
concurrent spending. That is the same guard class §3 already decided should
refuse on uncertainty.

---

## 8. Label vocabulary

**Fixed, not configurable**, and the harness **creates the labels at startup,
refusing the run if it cannot**.

The argument for fixing is not consistency — it is that fixed names can be
_guaranteed_. `gh label create` at startup makes Fact 2 structurally impossible.
Configurable names cannot do that: the harness would be validating bindings it
does not own.

Six labels, both kinds — the harness's own run state (`agent:implement`,
`agent:in-progress`, `agent:blocked`, `agent:exhausted`) **and** process
lifecycle (`ready-for-agent`, `ready-for-human`).

**What this costs, named plainly.** A consumer with no human-review stage gets
labels created in their repository that they never asked for. Label colour and
description become package-owned. Label creation is a durable write to a shared
human workspace, performed as a side effect of an unrelated run, and the harness
cannot cleanly reverse it. Create-at-startup was chosen over verify-and-refuse
for zero-setup installs, accepting that cost.

---

## 9. Prompts

The reversal that needed evidence, because issue **#2** — "Ship an agents
directory: default prompt with consumer overlay by name" — was **closed** on the
stated grounds that it "deliberately reverses a stated scope decision."

Measured against the live consumer's `agent/implement/prompt.md`, 147 lines:

| Half                     | Share | Content                                                                                                                                                                                         |
| ------------------------ | ----- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Procedure** (portable) | ~40%  | RED/GREEN/REFACTOR, quality gate before commit, verify phase, write a PR description                                                                                                            |
| **Environment** (local)  | ~60%  | `bun run typecheck/lint/format/test`, `bunx prisma migrate dev`, `DATABASE_PRISMA_URL`, Playwright's `webServer`, "the database is already seeded with the user `alice@prisma.io` (one recipe)" |

A shipped default can carry only the first half.

**Settled: a skeleton that is a thin invocation shim.** The default names the
phase and defers to the bundled skills plugin for procedure; the consumer's
prompt supplies environment. This resolves the overlap in the right direction —
#26 already put procedure in skills, and a shipped prompt carrying procedure too
would put the same content in two places with no rule for which wins.

Prompts are keyed by phase, since one verb discovers the phase from the payload.
A discovered phase with no prompt refuses at startup naming the phase, rather
than failing at spawn time.

---

## Residual

**One item is open.** A skeleton default with unfilled environment placeholders
fails the way `standardsDir` failed: present, plausible, wrong, and silent. A
consumer who skips the fill-in gets a run that spends tokens and then fails on
`bun run` in a repository with no bun. The shim does not fix this on its own.

**Recommended close:** refuse when the environment block is unfilled, so the
default can never silently half-apply. Small, and consistent with every other
refusal in this package — which has now spent two releases building guards
against exactly this shape.

**The mechanism was missing, and §11 supplies it.** "Refuse when unfilled"
needs something machine-checkable to refuse on, and today there is nothing:
`README.md:130` records that an unrecognized `{{TOKEN}}` renders as literal
text, unchanged and unreported. The scaffolder in §11 emits an explicit
sentinel and fills the block from the project's own lockfile and scripts, which
turns this from a recommendation into an implementation.

---

## Review — open flaws (2026-08-14)

Read back against the paper and the live consumer after the session settled.
Ordered by cost. Seven findings, and one decision above that should reverse
(§8, see §11).

### 1. The loop's only closure signal is tests. Evals are still zero

The paper's §2 is unambiguous: tests and evals **together**, or "it's still
vibe coding no matter how sophisticated the prompts are." §4 puts trajectory
evaluation above output evaluation. §5 above quotes that section's own line —
"a fluent output that skipped verification steps is more dangerous than one
with a visible error" — but spends it on handoff _authorship_ and never builds
a gate from it.

The machine edge fires on `workflow_run.conclusion: failure`. So the loop's
definition of done is **CI is green**, and an agent that deletes a failing test
to get there exits as a success. Twenty-four decisions and nothing stops it.
The trajectory checker is relocated in sequencing step 1 and stays advisory,
exactly as it is in the consumer today.

**Close:** the scorecard becomes a closure condition on the _success_ path, not
only a handoff input. A run whose trajectory violates `gate-before-commit` or
`red-before-green` does not reach `ready-for-human`; it re-enters the loop or
lands `agent:blocked`. Without that, the automated edge implements
think → act → observe-what-CI-said, which is not what §5.3 describes.

### 2. §2 puts the adversarial guard behind the spend it guards

§2 prices the one-verb collapse at "roughly a minute of CI." §1's own table
prices the live consumer's setup at 3–5 minutes billed. But the size is the
smaller problem: §3 identifies authorization as **the only guardrail whose
failure mode is financial and adversarial**, and one verb runs it _after_
`bun install`, Prisma generate, and Playwright. On a public repo, an
unauthorized actor forces full runner setup on every label event. The two-job
split §2 deletes is the thing currently preventing that.

**Close:** keep an admission phase that costs nothing. The sequencing knowledge
is still typed and tested — `classifyTrigger`, authorization, the ceiling, and
the concurrency check are exported as a callable a setup-free job runs first,
and `runPhase` re-checks them. The verb count argument survives; what does not
survive is running the spend gate after the spend.

### 3. The transition Fact 2 is about is still unspecified

§8 makes `ready-for-agent` and `ready-for-human` package-owned. §3's edge table
and §4's terminal states transition only `agent:implement`,
`agent:in-progress`, `agent:blocked`, and `agent:exhausted`. **No section says
where `ready-for-human` is set.** The document exists because that swap has
never once fired, and it does not say what makes it fire.

Presumably it lands with PR creation (§2), which is the natural seam. It should
be stated there, in the transition table §4 of the sequencing calls for, rather
than inferred — inference is how the bash layer got here.

### 4. No handoff exists on exactly the runs the ceiling is for

§4 declines to count `.agent/attempts/*` because a wall-clock kill or a crash
writes no file, so the count would be blindest against its own failure mode.
The argument is right and it applies to §5 unchanged: those runs also **teach
the next iteration nothing**, so the loop re-derives the same approach and
spends the ceiling doing it.

**Close:** split the write by authorship, which §5 already does. The
harness-authored half — CI failure tail, run id, diff, scorecard — is entirely
harness-owned facts and can be written unconditionally, including after a
`SIGKILL`. Only the agent's claims are legitimately unavailable on a kill, and
that section says so rather than being absent.

### 5. The derived count counts the wrong runs, and derived is not a lock

`gh run list --branch` counts every workflow on the branch. The live consumer
has three (`agent-implement.yml`, `test.yml`, `main.yml`), plus the
strip-screenshots push and the human-edge run itself. The call needs
`--workflow` and `--event` filters — and those filters are string bindings to
names the consumer owns, which is the shape of Fact 2.

§7 separately rejects `agent:in-progress` as a spend lock because it is mutable
and human-editable. Fair, but the replacement is **not a lock at all**: two
`workflow_run.completed` events landing together both read "none in flight" off
an eventually-consistent API. GitHub's real mutual exclusion is a
`concurrency:` group — which lives in consumer YAML, the layer §2 is deleting.
That tension is unresolved and should be recorded as a decision either way.

### 6. Observability fell out of the sequencing

[`docs/harness-gap-analysis.md`](./harness-gap-analysis.md) §3.3 names
stream-json parsing "the highest leverage remaining" and a prerequisite for
evals; the data already flows through the process and is dropped. This design
adds a loop that **multiplies spend by N** and adds no spend measurement at
all: the ceiling bounds attempts, while the paper's §8 argues in tokens.

Nothing here says observability was reconsidered and dropped, so it reads as
drift rather than as a decision. Either the ceiling gets informed by the usage
already on the wire, or the omission gets the same one-paragraph justification
every other omission in this document got.

### 7. The inner loop is the least designed part of the design

**Settled in shopfloor#40.** The three questions below are answered — the
harness runs a caller-stated gate command, each iteration is a fresh spawn fed
the previous failure, and the wall clock bounds the run while the idle guard
bounds a spawn. The reasoning lives in
[`CONTEXT.md`](../CONTEXT.md#the-inner-loops-three-decisions); the rest of this
finding is kept as the record of what was open.

§1 ranks it as where "the large majority of failures should be caught" and
sequencing puts it near the front. Its entire specification is "a `while` in
TypeScript" and "its own budget in `runPolicy`." Three questions decide whether
it is cheap or ruinous, and none is answered:

- **What generates the signal?** The harness running the consumer's gate, or
  the prompt telling the agent to? Today the gate lives in the prompt, which
  §9 says is per-consumer environment content the package never ships — so a
  harness-run gate needs a command contract that does not exist yet.
- **Respawn or resume?** A fresh spawn per iteration starts cold and pays full
  context again; `--resume` keeps the trajectory and risks the context rot §5
  warns about. This is the same static/dynamic decision §5 took for the outer
  loop, unmade at the inner one.
- **What do the two runaway guards cover?** If `wallClockMinutes` bounds one
  spawn, N iterations cost N × 45 minutes and every ceiling this document
  claims is fiction. If it bounds the loop, the existing per-run semantics
  change and `CONTEXT.md`'s invariant about wall-clock kills needs rewriting.

### Smaller, still real

- **`workflow_run` has prerequisites this document inherits without naming.**
  It triggers only from workflows on the default branch, and pushes made with
  `GITHUB_TOKEN` do not fire downstream events. The consumer's `AGENT_PAT` is
  now load-bearing on the machine edge — a requirement the harness should
  check, not an accident it depends on.
- **§8's ordering against §3 is unstated.** Label creation is a durable write
  to the consumer's repository. Whether it happens before or after the
  authorization probe decides whether an unauthorized trigger writes to someone
  else's repo. §11 makes the question moot.
- **§6 attributes the harness's own commit to the agent.** The
  strip-screenshots commit is authored by `claude-code[bot]`, so CI red caused
  by it reads as an agent failure and retriggers the loop.
- **"The table reaches four of the paper's six phases" overstates.** Two edges
  ship; the other two are deferred, and code review is reached only through
  them. The sentence is doing honesty work the count does not support.
- **Model routing (paper §8) never appears.** Plausibly out of scope, but a
  document that audits itself against the paper should say so rather than be
  silent.

---

## 11. Setup — `init` and `doctor`

Not part of the original session; added by the review. The paper makes
"Configuring the Harness" a phase of the SDLC (§5, _Harness in SDLC_ 1), and
its blunt conclusion is that **most agent failures are configuration failures**.
This package has no configuration phase at all.

Count what a consumer must independently get right today, and what this design
adds: two secrets, one of them a PAT with `workflow` scope; six labels; a
323-line workflow; a prompt carrying six exact placeholder tokens plus an
unfilled environment block; a CLI pin; and after this document, `workflow_run`
wiring, a concurrency group, and the branch and PR conventions the verb now
owns. Every one is an untyped string binding. That is the `standardsDir`
failure shape, replicated.

**Two commands, in the package's existing split.**

- **`shopfloor doctor`** — the durable half, and the one that earns its keep
  after day one. `probeSetup()` gathers facts; `evaluateSetup(facts)` is pure
  and returns a verdict, testable with no mocking. Non-interactive, idempotent,
  safe to run in CI. It checks `gh` auth and PAT scopes, secrets via
  `gh secret list`, the six labels, `claude --version` against the pin, the
  prompt's tokens against the six-token table, whether the environment block is
  filled, and whether the workflow is wired to the events §3 admits.
- **`shopfloor init`** — doctor plus writers, interactive, re-runnable, never a
  silent overwrite. Creates the labels, scaffolds the workflow and the prompt,
  and reads the project's lockfile and `package.json` scripts to **fill** the
  environment block rather than leaving placeholders. That is the
  [Residual](#residual)'s missing mechanism.

### This reverses §8's create-at-startup

§8 chose creating labels at startup over verify-and-refuse "for zero-setup
installs, accepting that cost" — a durable write to a shared human workspace,
performed as a side effect of an unrelated run, unreversible by the harness.

Once `init` exists, zero-setup is no longer the alternative it was weighed
against. The write moves to a moment a human asked for it, and `runPhase`
reverts to **verify-and-refuse** — consistent with every other guard in the
package, and Fact 2 stays structurally impossible either way, because the
verification is what makes it impossible, not the creation.

### Two constraints, so this does not become a framework

- **No config file.** The wizard generates the consumer's adapter and workflow.
  Resolution stays `explicit input → env var → probe → default`; a fourth
  source is a second model of state, which is the argument §4 and the
  `--plugin-dir` decision have both already made.
- **"Unfilled" must be machine-checkable.** The scaffold emits an explicit
  sentinel, and `runPhase` refuses on it. Refusing on a _missing_ value is not
  enough — an unrendered `{{TOKEN}}` is currently indistinguishable from prose.

---

## Amendments this forces to CLAUDE.md

Three scope lines under "What this package deliberately does not own" change,
and one new capability class appears. Listed together so they read as decisions
rather than as drift discovered one at a time.

| Line today                                                                                               | Change                                                                                                                                                                                                 |
| -------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| "**Prompt content** beyond the harness's invocation defaults — per-consumer"                             | Amended: a per-phase skeleton ships as a shim to the skills plugin. Environment content is still never shipped.                                                                                        |
| "**Consumer env-var names** — `requiredEnvVars` is caller-stated"                                        | Broken as a class: six label names are now package-owned, including two describing the consumer's process.                                                                                             |
| "**CI glue and workflow templates** — callers own `$GITHUB_OUTPUT`, exit codes, branch checkout, the PR" | Amended twice: the harness owns branch creation, PR creation, and issue state (§2), and §11 scaffolds a workflow template. Callers keep exit codes and checkout.                                       |
| _(new)_                                                                                                  | **The package writes to the consumer's repository** — creating labels, committing handoff files, opening PRs. That capability class did not exist before.                                              |
| _(new, from §11)_                                                                                        | **The package configures the consumer's repository** — an `init`/`doctor` pair that probes and scaffolds setup. Distinct from the row above: that one writes during a run, this one writes when asked. |

The scope boundary narrows in one direction and widens in four. That is worth
stating in `CLAUDE.md` rather than leaving to be inferred. Note that the
workflow-template line is amended by §11 as well as §2 — the original session
changed it once and the review changes it again.

---

## Suggested sequencing

Cheapest and most independent first; each is separately shippable.

1. **Relocate the trajectory checker** into `src/observability/`, deleting the
   consumer's copy. Its four invariants all reference facts shopfloor owns —
   `turn-budget-headroom` is `runPolicy.maxTurns`, `no-forbidden-git-ops` is
   `classifyCommand`'s own rule set, `gate-before-commit` / `red-before-green`
   are the implement phase's contract. It is the harness grading itself, exiled.
   No dependency on anything else here, and §5's harness-authored handoff needs
   it callable.
2. **`doctor`, then `init`** (§11). Independent of everything, cheap, and it is
   the step that makes the rest adoptable. It goes before step 5 because it
   **changes** that step: with `init` in hand, the label vocabulary verifies
   and refuses rather than creating at startup, so building step 5 first means
   building it twice. `doctor` ships before `init` — the verdict is the durable
   half; the scaffolder is convenience over it.
3. **The inner loop.** Cheap, no GitHub plumbing, catches most failures before
   they can reach the expensive loop. Needs its own budget in `runPolicy`, and
   the three answers review finding 7 asks for first — signal source, respawn
   versus resume, and what the runaway guards bound. Stated wrong, the ceilings
   this document claims do not hold.
4. **Authorization probe.** Independent of everything, and it is the guard with
   the adversarial failure mode. Currently untested YAML. Ships as its own
   callable, per review finding 2, so it can run before the runner spends
   anything.
5. **Label vocabulary + state machine** — the pure transition table, the `gh`
   shell, verify-and-refuse (not startup creation; see §11). Closes Fact 2, and
   is where `ready-for-human` finally gets a stated transition (review finding
   3).
6. **`classifyTrigger` + one verb**, absorbing branch and PR creation. The large
   consumer-YAML reduction lands here, minus the admission phase step 4 keeps
   cheap.
7. **Trajectory as a gate, and the trajectory-derived closure condition**
   (review finding 1). Depends on step 1 having made the checker callable, and
   it is what the outer loop's success path needs before it can be trusted.
   Absent this, step 8 ships a loop whose definition of done is "CI is green."
8. **The handoff artifact** — authorship, storage, read, strip, and the
   unconditional harness-authored half (review finding 4).
9. **The outer loop** — the machine edge, attribution, the filtered derived
   count, the ceiling, `agent:exhausted`, concurrency and whatever settles
   review finding 5.
10. **`1.0.0`**, with `standardsDir`-style refusal shims for every removed field.

Steps 8 and 9 are the only ones that depend on most of what precedes them.
Observability (review finding 6) has no step here, deliberately or otherwise —
that is the decision to take before step 9, not after it.

**Release.** `1.0.0`, not another `0.x`. The gap analysis §4 already flagged that
the `0.x` decision "may not survive §5"; this is several times larger than §5,
and it is the first release in which the package writes to the consumer's
repository. The consumer's exact pin means `1.0.0` costs nothing operationally —
it is purely a truthful signal. Refusal shims stay regardless: an environment
variable that silently stops meaning anything is the failure mode this
repository has now designed against twice.

---

## Also found

Unrelated to the design, found while establishing the facts above:
**`README.md` lines 351–602 are a verbatim duplicate of lines 50–350** — a bad
merge. `### CLI` appears twice, the first occurrence followed by a
`runImplementAgent` snippet rather than the bin invocation. Worth its own small
PR.
