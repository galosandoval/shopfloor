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

| Directory              | Owns                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/phase/`           | **The verb** (shopfloor#47): the `runPhase` shell and every decision behind it — `resolvePhasePrompt` and the shipped per-phase shims (`DEFAULT_PHASE_PROMPTS`), `buildPullRequestFields`, `evaluatePhaseOutcome` — plus the two shells it owns that nothing else did: `ensureAgentBranch` / `pushAgentBranch` and `ensurePullRequest`, each locate-or-create                                                                                                                                                                                                                                                                           |
| `src/orchestration/`   | `runImplementAgent` (the phase's run, internal since shopfloor#47), `resolveImplementConfig` (pure config resolution), `prepareClaudeInvocation` (pure CLI-argument assembly), `spawnClaude` (the subprocess with both runaway guards armed), `evaluateIteration` (pure inner-loop decision) and `runGate` (the shell that runs the consumer's quality gate), `resolveBundledPluginDir` (where the bundled skills plugin landed), `ImplementAgentError`                                                                                                                                                                                 |
| `src/guardrails/`      | The run-policy contract and its resolvers (idle and wall-clock budgets, required env vars), the pure CLI-version comparison, preflight refusal, authorization (`evaluateAuthorization` / `runAuthorization` — the spend gate), plugin-directory validation (`evaluatePluginDirs` / `runPluginDirsCheck`), the unfilled-prompt refusal (`evaluatePromptReadiness`), the label-vocabulary refusal (`evaluateLabelVocabulary` / `runLabelVocabularyCheck`), the trajectory closure condition (`evaluateClosure` — the gate on the success path, shopfloor#48), the command policy and its `PreToolUse` hook script, verify-comment posting |
| `src/observability/`   | Session transcript capture (for CI-artifact upload), the trajectory checker that grades a finished run over that transcript — the pure `checkTrajectory` / `formatScorecard`, the `resolveGatePatterns` that decides what counts as a gate run for a repository, and the `runTrajectoryCheck` shell; it still only _grades_, and what a run does about the grade is `guardrails/closure.ts` — and usage metering (`parseUsageEvent` / `accumulateUsage` / `summarizeUsage`, plus the `createStreamUsageReader` line adapter the spawn feeds bytes to). Advisory: it reports, it never fails a run                                       |
| `src/setup/`           | The setup doctor (`shopfloor-doctor`): the pure `evaluateSetup` / `formatSetupReport`, the pure `resolveDoctorConfig`, and the `probeSetup` shell. It judges the consumer's _configuration_ rather than a run, and writes nothing — read-only, idempotent, safe in CI. And over it the scaffolder (`shopfloor-init`): the pure `planInit` and the scaffold builders, and the `runInit` shell — the one thing in this package that writes to a consumer's repository                                                                                                                                                                     |
| `src/trigger/`         | The trigger boundary (shopfloor#46): the pure `classifyTrigger` over a raw webhook payload, the `agent/issue-<n>` branch convention (`agentBranchForIssue` / `issueNumberFromBranch`) both edges read and write, and admission — the pure `evaluateAdmission` and its `runAdmission` shell, which composes classification, the spend gate, the concurrency check, and the attempt ceiling (both read off the issue's own label history) into one verdict a job with nothing installed can gate on                                                                                                                                       |
| `src/issue-state/`     | The label vocabulary (`LABEL_VOCABULARY` / `REQUIRED_LABELS`) and the state machine over it: the pure `evaluateLabelTransition` and its `TRANSITION_TABLE`, the `applyLabelTransition` shell, and the one `gh issue comment` shell every comment this package writes goes through (`commentOnIssue` / `commentOnIssueBestEffort`). The names are **package-owned** — see the invariant below                                                                                                                                                                                                                                            |
| `src/process/`         | Subprocess plumbing no single shell owns: `asExecFailure` (the one narrowing of a rejected `execFile` — a spawn failure carries no numeric `code`, and that distinction is load-bearing in two shells) and the `node:child_process` stub their wiring tests share. Internal, never exported                                                                                                                                                                                                                                                                                                                                             |
| `src/index.ts`         | The public surface — nothing else is API                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `src/run-phase-cli.ts` | Thin bin entrypoint (`shopfloor-run-phase`); it names no issue and no branch — the payload does — and owns only the exit code and the failure-reason file                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `src/doctor-cli.ts`    | Thin bin entrypoint (`shopfloor-doctor`); prints the report and sets the exit code, nothing else                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `src/init-cli.ts`      | Thin bin entrypoint (`shopfloor-init`); prints the report and exits non-zero on a **write that failed** — never on the setup it cannot fix, which it names and leaves to the operator                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `src/authorize-cli.ts` | Thin bin entrypoint (`shopfloor-authorize`); prints the verdict and exits non-zero on any refusal. Its own bin so a setup-free job runs the spend gate before the runner installs anything                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `src/admit-cli.ts`     | Thin bin entrypoint (`shopfloor-admit`); prints the admission verdict as one line of JSON on stdout and the sentence on stderr. Exits zero on `not-a-trigger` — by far the most common outcome — and non-zero on every other refusal, so a caller who ignores stdout is still stopped by a stranger, a broken token, a run in flight, or a spent ceiling                                                                                                                                                                                                                                                                                |

## Pure core, IO shell

The structural convention every module here follows. A module that makes a
decision splits in two:

- **A pure function** — takes already-gathered facts, returns a verdict or a
  plan. No `fs`, no `child_process`, no `process.env`, no clock; an environment
  it needs arrives as a parameter (`resolveImplementConfig(input, env)`). Named
  `evaluate*` / `check*` / `classify*` / `resolve*` / `prepare*` / `build*`.
- **A thin shell** — runs the probes (`git`, `gh`, `claude --version`, `fs`),
  hands the raw results to the pure function, acts on the verdict. Named `run*`
  / `post*` / `apply*` — the last two where the verb says what the side effect
  _is_ and `run*` would say only that something happened
  (`postVerifyComment`, `applyLabelTransition`).

The naming tracks what a function _decides_, not which half it sits in. A shell
that decides nothing and only locates something — `resolveBundledPluginDir`,
and the private `resolveCommandGuardHookPath` beside it — keeps `resolve*`,
because the alternative is a `run*` name promising a verdict it does not
produce. Anything that judges is either pure or does not belong here.

The pairs: `evaluatePreflight` / `runPreflight`, `classifyCommand` /
`command-guard-hook`, `buildVerifyComment` / `postVerifyComment`,
`evaluateAuthorization` / `runAuthorization`,
`evaluatePluginDirs` / `runPluginDirsCheck`, `checkTrajectory` /
`runTrajectoryCheck`, `evaluateIteration` / `runGate`, `evaluateSetup` /
`probeSetup`, `planInit` / `runInit`, `evaluateLabelTransition` /
`applyLabelTransition`, `evaluateLabelVocabulary` /
`runLabelVocabularyCheck`, `evaluateAdmission` / `runAdmission`,
`checkCliVersion`, `classifyTrigger`,
`evaluatePromptReadiness`, `evaluateClosure`,
`resolveImplementConfig` / `runImplementAgent`, and the verb's own —
`resolvePhasePrompt`, `evaluatePhaseOutcome`, and `buildPullRequestFields` /
`ensurePullRequest`.

`probeSetup` is the one shell that neither runs nor applies anything, and
deliberately: it gathers and decides nothing, while every `run*` here acts on a
verdict.

A new module lands in that shape: name the decision, export it as a pure
function with its own input type, put it in `src/guardrails/` (a decision about
whether or how a run may proceed), `src/orchestration/` (a decision about what
to run), `src/observability/` (a judgement about a run that already
finished — it reports, it does not decide anything the run then obeys),
`src/setup/` (a judgement about the consumer's configuration, made before any
run exists), `src/issue-state/` (a decision about what an issue should be
labeled with next), or `src/trigger/` (a decision about whether an event starts
a run at all, taken before one exists), and let
the shell own every side effect. The shell should read gather →
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

One default is the exception, and it is one the rule forces rather than one
that escaped it: `pluginDirs` falls back to the bundled plugin, whose location
is a filesystem lookup, and a pure resolver may not do IO. So the resolver
leaves the field **undefined** — its whole job, keeping "unstated" apart from
"stated as empty" — and `runImplementAgent` supplies the fallback in one line
before the preconditions. A default that has to be _found_ lands in the shell;
every default that can be _stated_ stays in the resolver.

## The run, end to end

`runPhase(rawEvent)` is the whole flow (shopfloor#47). One verb, because the
verb count was never the interface — the **sequencing** was, and it used to
live in 323 lines of consumer YAML with three `|| true` blocks and a transition
that had never once fired. What a caller still owns is checking out the
repository, the exit code, and the setup-free admission job in front of this
one. Everything else, in order:

1. **Re-check admission** — `runAdmission` over the same raw payload
   (`GITHUB_EVENT_PATH` when the caller passes none): classification, the spend
   gate, the in-flight narrowing, the attempt ceiling. The cheap
   `shopfloor-admit` job still runs first and is still where the spend gate
   belongs (design review finding 2); this is the re-ask, so a run reached by
   any other path is judged rather than admitted by assumption. **A refusal
   here writes nothing at all** — the same rule `runAdmission` follows, and the
   only one that is safe for the in-flight case, where the issue belongs to a
   run this one does not own.
2. **Resolve the phase's prompt** — pure `resolvePhasePrompt`, before anything
   is written or spent. A phase with no prompt refuses **at startup naming the
   phase** rather than failing at spawn time. The shipped default is a thin
   shim to the bundled skills plugin: procedure already lives in skills, and
   environment content still ships to nobody. `PROMPT_FILE` keeps working and
   applies to whichever phase the payload discovered.
3. **Preflight, on the human edge only** — `runPreflight` refuses a PRD, a
   sub-issue, or an issue a PR already links. It is the one refusal that _does_
   write: the judgement is about the issue, so it applies the table's `refused`
   row and comments before this verb returns. The machine edge skips it because
   its third refusal — an open PR already targets this issue — is on a
   retrigger the loop's own PR, so asking there would refuse every continuation
   on the evidence that the previous attempt worked. It also verifies the label
   vocabulary for the rows below; the machine edge, having skipped it, runs
   `runLabelVocabularyCheck` itself — no transition in this package is applied
   without that check in front of it.
4. **Probe the issue title**, once — the prompt and the PR are named from the
   same read, so the two can never disagree.
5. **Transition to `started`** — before the branch exists, so a run killed
   between the two is still visible as one that started.
6. **Locate or create the branch** — `ensureAgentBranch`, on the name
   `agentBranchForIssue` writes down and nothing else re-derives. A retrigger
   finds the remote branch and continues it; only a first attempt creates one.
7. **Run the phase** — `runImplementAgent`, below, unchanged and now internal.
   **A failed run pushes what it committed** before it transitions and
   rethrows, best-effort: an ephemeral runner would otherwise take the work
   with it, and the human the terminal row is about to summon would arrive at
   `agent:blocked` with nothing to read. No PR is opened for it — unvetted work
   is not a pull request; the branch is there to be looked at.
8. **Push, then locate or create the pull request** — `ensurePullRequest`,
   draft, closing its issue exactly once. A retrigger iterates on the PR
   already open rather than failing on a second `gh pr create`.
9. **Post the verify comment**, best-effort, pinned to the commit this run
   pushed rather than to `GITHUB_SHA`.
10. **Transition on the outcome** — `evaluatePhaseOutcome` decides between
    `succeeded`, `exhausted` (the inner loop spent its ceiling with the gate
    red), and `failed`. **Every one of the three is applied, including on the
    way out of a throw**, and each terminal row sets `ready-for-human`: this is
    where that transition finally fires, and an issue left in
    `agent:in-progress` forever is what the layer this replaced did instead.

### The phase's run, end to end

`runImplementAgent` — reached through `runPhase`, no longer API — is:

1. **Resolve config** — `resolveImplementConfig`, pure, over the caller's input
   and an env record. It also refuses a run still configured for the removed
   `standardsDir` / `STANDARDS_DIR` (shopfloor#27): the check needs no IO, so it
   belongs here rather than among the preconditions below, and it runs before
   anything else the resolver can fail on.
2. **Resolve the plugin list** — an unstated one is the bundled plugin
   (`resolveBundledPluginDir`); a stated one replaces it, empty included. The
   lookup is filesystem work, so it happens here in the shell rather than in
   the pure resolver, which leaves `pluginDirs` undefined precisely so
   "unstated" stays distinguishable from "stated as empty".
3. **Verify preconditions** — first, and before any probe spends time or any
   token is spent: the caller's required env vars, that the prompt carries
   neither `init`'s sentinel nor a token nothing substitutes
   (`evaluatePromptReadiness`, shopfloor#44), that every plugin directory
   — the bundled one included,
   with no exemption — is a plugin carrying skills and neither hooks nor MCP
   servers, that the repository carries the label vocabulary the run's issue
   transitions are written against (`runLabelVocabularyCheck`, shopfloor#45 —
   it verifies, it never creates), and the running `claude --version` against
   the policy's pin.
   Returns the running version for the run result. The label check is the one
   that costs a network round trip, so it sits last but one, after every local
   check has had its chance to refuse for free.
4. **Probe what's still unstated** — branch and issue title, via lazy `git` /
   `gh` calls in the shell. These run _after_ the preconditions, so a
   misconfigured run never pays for them.
5. **Iterate** — steps 5a–5d, once for a run with no gate stated, and up to
   `runPolicy.maxIterations` times for one with a gate. This is the inner loop
   (shopfloor#40); its three settled decisions are below.
   1. **Assemble the invocation** — `prepareClaudeInvocation`, pure: flags (one
      `--plugin-dir` per validated plugin directory), the rendered prompt with
      the previous iteration's gate failure appended (nothing appended on the
      first), and the inline `--settings` payload that arms the command-guard
      `PreToolUse` hook. Output always streams, because the idle guard reads the
      child's output as its heartbeat.
   2. **Spawn** — `spawnClaude`, with the idle budget and _what is left of_ the
      wall-clock budget armed. OAuth only; `ANTHROPIC_API_KEY` is stripped from
      the child env so a run can never fall through to a metered key. The
      child's stdout is metered as it arrives (shopfloor#42) and the spawn
      reports what it spent.
   3. **Capture the transcript**, best-effort, for the caller to upload.
   4. **Run the gate and decide** — `runGate` executes the caller's
      `runPolicy.gateCommand`, and the pure `evaluateIteration` returns done,
      iterate, or exhausted. A runaway kill or a non-zero CLI exit short-circuits
      this and fails the run: the loop corrects work the gate judged, not a spawn
      that never finished.
   5. **Grade the trajectory and close, or not** (shopfloor#48) — a `done`
      verdict is no longer where the run ends. `runTrajectoryCheck` grades the
      transcript this iteration just captured, and the pure `evaluateClosure`
      returns pass, re-enter, or block. Only `pass` returns a result; a
      re-entry becomes another iteration carrying the violated invariants as
      feedback, and a block fails the run. The section below has the whole of
      it.
6. **Check the result** — an exhausted budget with the gate still red fails the
   run; so does a run that committed nothing. A missing PR description falls
   back rather than discarding finished commits.

### The inner loop's three decisions

Each was open before shopfloor#40 and is settled here rather than left implicit
in the code.

- **The harness generates the signal.** `runPolicy.gateCommand` is a command the
  _harness_ runs and reads the exit status of, not an instruction to the agent
  to check itself. An agent reporting its own gate green is the
  fluent-output-that-skipped-verification failure the loop exists to catch, so
  the signal has to be observed rather than claimed. The command is
  caller-stated, on the same footing as `requiredEnvVars`: `bun run typecheck`
  is a consumer's vocabulary, and prompt environment content still ships to
  nobody. Unstated, there is no signal and the run stays single-shot — the
  behaviour of every run before this loop existed — **with one exception since
  shopfloor#48**: a gateless run whose trajectory does not close still iterates,
  because the trajectory is a second signal and, unlike the gate, it needs no
  consumer configuration. The invariants it grades are this package's own.
- **Each iteration is a fresh spawn, not a `--resume`.** The static/dynamic
  decision, taken toward static. Resuming would keep the reasoning that produced
  the failing work inside the context of the turn meant to correct it, which is
  the context rot the design doc warns about; it would also need a session id
  this package does not parse out of the CLI's stream, and would be unavailable
  exactly when a spawn was killed. The cost is real and named: every iteration
  pays for its static context again. What makes the next turn different from the
  last is `evaluateIteration`'s feedback — the gate command and a bounded tail
  of its output, appended to the prompt.
- **Wall-clock bounds the run; idle bounds a spawn.** A per-spawn ceiling would
  make N iterations cost N × the stated budget, and every ceiling claimed
  elsewhere fiction. So the wall clock is spent across the loop: each spawn is
  armed with the remainder, and a run with none left fails rather than starting
  another. Idle stays per-spawn because silence is a property of one live
  process — there is no such thing as a process that fell quiet between spawns.
  A single-iteration run is armed exactly as it was before the loop existed, so
  the change is invisible to a run that never iterates. The gate's own runtime
  is charged to the same clock: a gate is usually the whole test suite, and a
  budget that billed only the spawns would be overrun by one gate per iteration.
  The loop also stops a little above zero
  (`MIN_ITERATION_WALL_CLOCK_MS`) rather than at it, so the run ends naming the
  budget it spent instead of starting one last spawn for the guard to kill and
  reporting a runaway agent.

Two consequences of the loop that are not decisions, but are worth knowing. The
gate runs on the run's own `env` rather than the CLI's `childEnv` — the
OAuth-only rule constrains the agent's auth, and the gate is not the agent. And
`transcriptFile` holds the **last** iteration's session, since every pass
overwrites it, so each failed attempt is copied to
`transcript.iteration-<n>.jsonl` before the next spawn replaces it: those are
the attempts that explain why the run needed the loop, and they are the evidence
a bare overwrite would destroy on exactly the runs worth auditing. This is not
the outer loop's handoff artifact, which is a synthesis and a later step — it is
just refusing to delete something the run already produced.

### The closure condition

shopfloor#48, design review finding 1. With the outer loop's machine edge
firing on `workflow_run.conclusion: failure`, the loop's definition of done was
**"CI is green"** — and an agent that deletes a failing test to get there exits
as a success. The trajectory checker could already prove that wrong and did
nothing about it. `evaluateClosure` is the half that acts, and four things
about it are decisions rather than implementation.

- **Two invariants gate; two stay advisory, and the list is stated.**
  `gate-before-commit` and `red-before-green` are the implement phase's own
  contract, and both are exactly what a shortcut to green violates.
  `no-forbidden-git-ops` stays advisory because the command guard already
  refuses those _at spawn time_ — a finding there reports on a guardrail that
  acted, and blocking would be a second punishment for something that did not
  happen. `turn-budget-headroom` stays advisory because it is a capacity
  signal: a run that nearly used its turn cap did nothing wrong, and gating on
  it would block long work for being long. Not every finding is a gate, and
  which ones are is written down rather than inferred from the scorecard.
- **No evidence blocks, and this is the one place the "unreadable signal
  proceeds" rule does not hold.** A missing, empty, truncated, or malformed
  transcript grades nothing, and the run does not close on it. The question is
  whether capture wrote **this attempt's** session, not whether a file is
  readable: `captureTranscript` returns false without touching its destination
  and `preserveIterationTranscript` copies rather than moves, so a failed
  capture leaves the previous attempt's transcript in place — readable, and
  about a different attempt. Grading that would close a run on evidence of
  something else, which is the walk-past this gate exists to refuse, so an
  uncaptured attempt never reaches the checker at all. Everywhere else
  in this package an unreadable signal proceeds, because a missing _diagnostic_
  must not cause an outage — but this stopped being a diagnostic the moment it
  became the success path's closure condition, and a gate satisfied by the
  absence of evidence is one anything walks past by producing no transcript.
  The direction that costs least is still the rule, and it points here: the
  branch is pushed, the issue is labelled for a human, and the work is
  recoverable — while an unvetted test-deleting PR merged as a success is not.
  It also never re-enters the loop, even with budget left: another spawn
  corrects work a scorecard judged, and cannot conjure a transcript that was
  never written. The three ways to arrive with nothing graded — no scorecard at
  all, a scorecard silent on the gating invariants, and one with no turns to
  measure them against — share the `no-evidence` cause and state _which_
  happened in the reason, because they are different things for a human to go
  fix and a graded-but-empty run reported as an unreadable file sends them to
  the wrong one.
- **A violation spends an attempt out of the _same_ ceiling a red gate does.**
  `checkIterationBudget` is one function both ask, because two copies of a
  ceiling is how a ceiling stops being one. With budget, the run re-enters
  carrying the violated invariants as feedback — facts and one line of
  contract, the same restraint the gate's feedback keeps, because how to work
  test-first is the skills plugin's and a second copy here would have no rule
  for which wins. With none, the run **fails**, which is `agent:blocked`: a
  green gate reached on a broken process is _something is wrong_, not _the work
  is harder than specified_, so it is deliberately not `agent:exhausted`. The
  block travels on `ImplementAgentError.closure`, and `runPhase` says on the
  issue which invariants it was — `agent:blocked` says a human is needed, and
  nothing else on that path says what for. The comment is posted **before** the
  transition, since the transition is a `gh` call that can fail and the comment
  holds the only copy of the invariant list a human sees on the issue: a lost
  label leaves an issue mislabelled, a lost comment leaves `agent:blocked` with
  no statement of what blocked it.
- **It blocks the `succeeded` row, not `ready-for-human`.** The design says a
  violating run "does not reach `ready-for-human`". Read against the transition
  table that means the clean-success row: `ready-for-human` marks whose move it
  is, and every terminal outcome sets it, blocked runs included. What the gate
  prevents is a run **closing as a success**, which is the property the design
  was actually about.

Two bounds worth knowing. The scorecard grades **one session** — the attempt
that just finished, not the run's history — so a re-entered run is judged on
how _that_ attempt behaved, which is the right question to ask of an attempt
and is also why the earlier iteration transcripts are kept beside it. And the
gate patterns the check grades against are the package defaults **plus the
consumer's own `runPolicy.gateCommand`, matched literally**: without that,
`gate-before-commit` would fire falsely on every repository whose gate is not a
bare test command, since the agent running exactly the command the harness runs
would not be recognized as running the gate.

The caller owns what is left outside the verb: checking out the repository, the
admission job in front of it, sandboxing, and the exit code.

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
- **Except authorization, which refuses on uncertainty — the one inversion.**
  `evaluateAuthorization` (shopfloor#41) is the only guardrail whose failure
  mode is **financial and adversarial** rather than operational, and it is the
  only one that refuses when its signal is unreadable. Everywhere else an
  unreadable signal proceeds, because a missing diagnostic must not cause an
  outage; here an unreadable signal means "I do not know whether this person
  may spend your money," and proceeding is the expensive direction. So an
  errored probe, an empty answer, a probe never taken, and a permission level
  the guard does not recognize all refuse — including an organization's custom
  repository role, which is a name it has never seen rather than evidence of
  push access. The refusal keeps **not-permitted apart from
  could-not-determine** for the reason the doctor keeps `unknown` apart from
  `wrong`: they are a trespasser and a broken token, and collapsing them files
  an outage under a security message. The shell is also the one refusal that
  **writes nothing** — labeling or commenting on refusal would hand any
  drive-by triager a way to make the harness write to the repository. It ships
  as its own bin (`shopfloor-authorize`) because a spend gate that runs after
  the runner's setup has already let the spend happen (design review finding
  2).
- **Admission inherits that inversion, and is the second guard to refuse on
  uncertainty.** `evaluateAdmission` (shopfloor#46) composes the spend gate
  with two questions that are also about spend — is a run already in flight on
  this issue, and has the issue already had its attempts — so an unreadable
  run list refuses. It is not "probably no runs": it is not knowing whether
  something is already spending, and both unknowns resolve in the expensive
  direction. It writes nothing on any verdict, for the reason the spend gate
  writes nothing.
- **The two edges are authorized by two different facts, and the machine edge
  is not probed at all.** `AdmissionAuthority` (shopfloor#46) names them:
  `permission` on the human edge, where a person triggered the run and the
  spend gate probed what they may do; `continuation` on the machine edge, where
  nobody triggered it. Probing there asks the wrong question and gets a wrong
  answer — `workflow_run.triggering_actor` is frequently `github-actions[bot]`,
  whose collaborator permission is `none`, so the edge refused every time. What
  authorizes a continuation is that pushing to `agent/issue-<n>` **on the
  repository itself** already requires write access, which is a spending
  permission. That makes `classifyTrigger`'s two machine-edge fences part of
  the spend gate rather than attribution niceties: the head repository must be
  this repository (a fork PR's branch name and commit author are both
  attacker-chosen), and the head commit must be authored by
  `AGENT_COMMIT_AUTHOR`. Neither may be relaxed without moving authorization
  somewhere else first.
- **The admission phase exists so the sequencing can be typed without moving
  the spend gate behind the spend.** Design §2 collapses the public surface
  into one `runPhase(rawEvent)`; review finding 2 is that one verb runs
  authorization after `bun install`, Prisma generate, and Playwright, so on a
  public repository an unauthorized actor forces full runner setup on every
  label event. Admission is the answer: classification, authorization, the
  ceiling, and the concurrency check ship as a callable — and the
  `shopfloor-admit` bin — that a job with **nothing installed but this package
  and `gh`** runs first. The verb count argument survives; paying before
  deciding does not. Anything added to admission must keep that property: a
  probe that needs a checkout or an install belongs in the run, not here.
- **The ceiling and the concurrency check are read off the issue, which
  reverses design §4 and §7.** Those sections derive both from
  `gh run list --branch`, on the reasoning that a label is state the harness
  must then keep consistent. **That mechanism cannot fire.** A workflow run
  triggered by `issues.labeled` — or by `workflow_run` — executes on the
  default branch, so its `head_branch` is `main`, and a list filtered by
  `agent/issue-<n>` is empty on every real run; checked against the live
  consumer, where every `issues`-triggered agent run reports
  `headBranch: main`, and the only per-issue handle on a run is
  `displayTitle`, the issue title — editable prose. Derive-don't-store was
  argued against an alternative that never fires, so it loses here. What
  replaces it writes nothing new: the `started` transition already adds
  `agent:in-progress`, and GitHub keeps every `labeled` **timeline event**
  permanently — after the label is removed and after any `always()` clear. So
  **attempts** is how many times that label was ever added (history no later
  edit can rewrite, and it counts runs killed before they cleaned up — the
  blind spot §4 rejected file-counting for), and **in flight** is whether the
  label is on the issue now. Only the second reads mutable state, and only it
  can be fooled.
- **The concurrency check is a narrowing, not a lock** — review finding 5's
  other half, settled here rather than left open. §7's rejection of the label
  as a _lock_ stands unchanged and is the reason this is not one: a maintainer
  clearing a stuck `agent:in-progress` by hand silently unlocks concurrent
  spending, and two events landing together can both read it absent. The real
  mutual exclusion is a `concurrency:` group, which lives in consumer YAML and
  stays there; the scaffolded workflow already carries one. Reading the label
  is a cheap check in front of that lock, never a replacement for it.
- **The attempt ceiling lives on admission, not in `runPolicy`.** Design §4
  puts it "beside `idleMinutes` and `wallClockMinutes`"; it is not there,
  because admission runs before a run exists and never constructs a run policy.
  A policy field nothing in a run reads is the wall-clock guard's failure shape
  — implemented, tested, exported, documented, and never called.
- **The human edge is keyed on the label that was _added_, never on the issue's
  label set.** The harness adds labels of its own (`agent:in-progress` at the
  start of a run), and every one of those fires `issues.labeled` again. A
  classifier reading the set would restart the run it just started. The
  classifier also never throws: every label anyone adds to any issue reaches
  it, and an unrecognized or malformed payload is "not a trigger for us", not
  an error.
- **`shopfloor-admit`'s exit code splits where `shopfloor-authorize`'s does
  not.** That command is the last word on a spend, so every refusal leaves
  non-zero. Admission is a gate whose _output_ is read, and its most common
  outcome by far is `not-a-trigger` — painting a repository red for events
  where nothing happened is how a check gets deleted (the same argument behind
  the CLI-version check warning by default). So `not-a-trigger` exits zero and
  every other refusal exits non-zero, which keeps a caller who ignores stdout
  fail-safe against a stranger, a broken token, a run in flight, or a spent
  ceiling.
- **A plugin may add prose, never execution.** A stated plugin directory is
  refused if it ships hooks or MCP servers, from its manifest or from the
  convention directories alike. These runs pass
  `--dangerously-skip-permissions`, so permission declarations are moot; what
  is not moot is code that runs without the model choosing it, and tools the
  command guard cannot see — it matches shell commands only. This is also the
  tripwire on the bundled plugin's merge loop: it fires the day an upstream
  change adds automatic execution, rather than that change arming silently in
  every consumer's run. The bundled plugin gets no exemption from any of it.
- **The bundled plugin is a pinned git dependency, never a vendored copy.**
  `galosandoval-skills` is a fork that merges from upstream regularly; a copy
  in this repository would give every one of those merges a second destination,
  by hand, with a stale copy looking identical to a fresh one. A **tag**, never
  a branch — a branch resolves to different content on two installs a day
  apart. And a **git** dependency rather than a registry one, so the fork never
  has to publish a version and changelog that would fight every upstream merge.
  Bumping it is editing the tag in `package.json`; fork tags use the
  `galosandoval-skills@<version>` scheme so incoming upstream `v*` tags cannot
  collide with them.
- **The two runaway guards catch different failures.** Idle catches a _stalled_
  agent; wall-clock catches a _looping_ one that stays chatty forever and is
  structurally immune to the idle guard. Neither substitutes for the other.
- **The two runaway guards bound different scopes.** The idle budget is armed
  in full on every spawn; the wall-clock budget belongs to the **run** and is
  spent across its iterations. Anything that adds a spawn to a run must take its
  wall-clock budget from the same remainder, or the ceiling stops being one.
- **The run result names its spend, and nothing in this package acts on it
  yet.** `usage` (shopfloor#42) is the CLI's `stream-json` parsed as it arrives
  — the stream the idle guard was already reading for a heartbeat, and that the
  harness otherwise dropped. It lands on `RunImplementAgentResult`, summed over
  every iteration, because a loop that multiplies spend by N and measures only
  attempts is a ceiling on the wrong axis (design review finding 6). **Its
  consumer today is the caller** — CI glue reporting a run's cost, and evals,
  for which §3.3 of the gap analysis names this the prerequisite. The ceiling
  that reads it is the outer loop's, and it is not built; that this is a
  measurement and not yet a guardrail is deliberate, and the order the design
  asked for. Which is why metering breaks the package's usual pure/shell pairing
  and has no `run*` half: it decides nothing. It reports, like everything else
  in `src/observability/`. A **failed** run reports on
  `ImplementAgentError.usage` instead, since it never reaches a result — and
  the runs worth costing are exactly the ones that did not finish. Only a
  refusal from before the spawn carries none, where the answer is nothing.
- **A spend total is only a total when every spawn reported one.** `usage.source`
  keeps the CLI's own tally apart from this package's sum over the messages it
  watched go by, for the reason the doctor keeps `unknown` apart from `wrong`: a
  killed run's partial count read as a total would misstate exactly the runs
  worth costing. Misstate, not understate — an observed sum undercounts output
  and cache-creation but *over*counts input and cache-read, since every turn
  re-sends the conversation and each message restates the prefix the turns
  before it already reported. `RunUsage.source` documents the split per bucket. A metering failure never fails a run — an unreadable
  diagnostic must not cause an outage, and unlike authorization the failure here
  is neither financial-and-adversarial nor a permission to spend.
- **A wall-clock kill fails the run even if commits exist** — a run cut off
  mid-loop never reached its own verify phase, so the work is unvetted. It also
  never becomes another iteration: only a gate verdict on a finished spawn
  does.
- **A run that spends its budget with the gate red fails.** Iterating is not a
  best-effort wrapper around a failing run — a loop that returned unvetted work
  as a success would be a more expensive version of the single-shot run it
  replaced.
- **A green gate is necessary and no longer sufficient.** Since shopfloor#48 a
  run also has to close on its own trajectory, and the two gating invariants
  are the ones a shortcut to green violates. This is the only guardrail in the
  package that **refuses on an unreadable signal without being about spend** —
  authorization and admission refuse on uncertainty because the failure is
  financial and adversarial; this one refuses because the signal _is_ the
  definition of done, and a definition of done that an absent file satisfies is
  not one. The whole argument, and what stays advisory, is § "The closure
  condition".
- **Probes are best-effort and lazy.** A probe that answers nothing becomes an
  error naming what to state instead, never a silent default.
- **The doctor holds "unknown" apart from "wrong".** A setup check whose probe
  answered nothing reports `unknown` and does not fail the verdict or the exit
  code. Collapsing the two would make a doctor that cannot find `gh`
  indistinguishable from a repository that is misconfigured, and a diagnostic
  that cries wolf on its own blind spots is one people stop running.
- **`init` writes only what the verdict says is missing, and only what it can
  account for.** The scaffolder plans from `evaluateSetup`'s checks rather than
  from its own reading of the repository, which is what makes running it twice
  a no-op instead of two sets of writes that happen to agree. Three refusals
  fall out of the same rule and are deliberate: an `unknown` label read creates
  nothing (creating six labels on an unreadable probe is a durable write to a
  shared human workspace made on no evidence); an existing file is overwritten
  only after an operator confirms, and a run with no TTY declines rather than
  assuming yes; and a prompt with no environment fences is left alone entirely,
  because its environment is prose this package cannot locate and rewriting it
  would destroy the one thing `init` exists to fill.
- **A value `init` cannot determine is a sentinel, never a guess.** The
  environment block is filled from the project's lockfile and `package.json`
  scripts, and anything unreadable becomes `TODO(shopfloor)` — which the
  doctor's `prompt-environment-block` check already fails on. This is the
  mechanism the design's Residual was missing: a scaffold that emitted a
  plausible default would replicate the `standardsDir` failure shape, present
  and wrong and silent, in the one file a run cannot work without. **The
  workflow's sentinels get their own check for the same reason** —
  `workflow-unfilled`. Greppable is not machine-checkable: a `workflow_run`
  block whose `workflows:` names a sentinel is still wired to the event, so
  `workflow-triggers` passes and the edge fires from nothing. A sentinel
  nothing refuses on is prose with a `TODO` in front of it.
- **And the run refuses on it too, not just the doctor.** shopfloor#44 closes
  the design's one open item: a prompt still carrying the sentinel, or a
  `{{TOKEN}}` outside the substituted six, fails among the preconditions rather
  than rendering as literal text and buying a full run that dies on a command
  the repository does not have. The check reads the **template**, not the
  rendered prompt: on tokens that is the same verdict — rendering only ever
  removes known ones — and reading it early is what puts the refusal ahead of
  the `git` and `gh` probes. On the sentinel the two differ, deliberately: one
  arriving inside a substituted _value_, an issue title say, is the issue's
  data, and refusing over it would let any issue's prose block the loop. A
  **missing** token still refuses nothing — leaving one out is a consumer's
  choice, and the doctor's `prompt-tokens` check is where it is reported.
- **The run and the doctor are not one check, and the run is the stricter.**
  The doctor reads the sentinel only inside the environment fences and
  tolerates spaces and lower-casing in a token; the run refuses on a sentinel
  anywhere in the prompt, and on any identifier-shaped `{{ token }}`
  substitution would not render — `{{ ISSUE_NUMBER }}` included, since the
  renderer matches `{{TOKEN}}` and nothing else, so a spaced one reaches the
  agent as literal text exactly like a misspelling. The split runs the way the
  invariants above already do: a diagnostic tolerates what it cannot be sure
  about, a gate on spend does not. Making them one matcher is a change to the
  doctor's strictness, not to this guard.
- **Creating labels belongs to `init`, not to a run.** The design's §8 chose
  creating them at startup, weighed against zero-setup installs; once `init`
  exists that alternative is gone, so the write happens at a moment a human
  asked for it and the run's side is verify-and-refuse. Nothing in
  `runImplementAgent` has ever created one, so this is the decision being
  settled rather than code being reverted. The refusal is what closes the hole,
  not the creation: a run that cannot see the six labels never spawns, so a
  transition onto a label that does not exist is unreachable. It refuses on an
  **unreadable** label list too, which is stricter than the doctor's `unknown`
  — the split is the usual one, a diagnostic tolerates its blind spots and a
  gate on spend does not — and the reason still names unreadable and missing
  apart, because an unauthenticated `gh` and an unconfigured repository are
  different things to go fix.
- **The six label names are package-owned, and that is the one break in the
  "consumer names are caller-stated" rule.** A name the harness does not own is
  a binding it cannot guarantee; the concrete cost of not owning them was a
  `ready-for-human` swap in the live consumer that had never once fired,
  swallowed by `|| true`, because the label did not exist. Configurable names
  could only ever be validated against bindings this package does not own.
- **The transition table is exhaustive over outcomes, and the table is the
  whole state machine.** `TRANSITION_TABLE` has one row per `RunOutcome` and
  the type makes a new outcome a compile error rather than a silent
  fall-through — a state machine whose unhandled case is "leave the labels
  alone" is how an issue gets stuck in `agent:in-progress` forever. Each row is
  a **target set**, not a list of edits: the edits are derived against the
  issue's real labels, which is what makes a transition idempotent and correct
  from any starting state, including one a human left by editing labels
  mid-run. Only vocabulary labels are ever removed — a consumer's own labels
  are outside what this package owns, and clearing them would be enforcing a
  model of state it does not have. **`ready-for-human` is set by every terminal
  outcome**, whatever the run produced: it marks whose move it is, not whether
  the work is good, and the `agent:` labels are what say which kind of
  attention is wanted. Stated rather than inferred, because inference is how
  the bash layer got here (design review finding 3).
- **Every caller of `applyLabelTransition` in this package verifies the
  vocabulary first.** `runImplementAgent` does it among its preconditions;
  `runPreflight` does it as its first act, before it reads the issue, because
  it is reached both from `runPhase` and, in a consumer's own tooling, on its
  own. `runPhase` inherits that check on the human edge, where preflight runs
  before the `started` transition; on the machine edge, which skips preflight,
  it makes the check itself. Either way no row is applied without it. A shell that
  applies a row without the check in front of it is the rotted binding
  shopfloor#45 exists to eliminate, so the two go together. A missing
  vocabulary **throws** rather than becoming a refused verdict: a verdict says
  this issue must not be implemented and is answered by labelling it, and
  labelling is what an unconfigured repository cannot be trusted to do.
- **The package owns the transition, and since shopfloor#47 it applies every
  row.** `runPreflight` applies `refused`; `runPhase` applies `started` before
  the branch exists and `succeeded`, `exhausted`, or `failed` on the way out —
  the failing ones inside the `catch`, before the error is rethrown, so no way
  out of a started run leaves the issue in flight. `applyLabelTransition` and
  the table stay exported anyway: a consumer's own glue acting on a run should
  apply _the_ transition rather than a second guess at it.

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

The same line decides what this package ships to consumers, and it narrows the
scope boundary rather than reversing it: **procedure ships, standards do not.**
The bundled plugin (shopfloor#26) carries skills — how work gets done, portable
across repositories — and installing this package brings them. Opinionated
coding standards still ship to nobody, and are no longer pointed at either:
shopfloor#27 removed `standardsDir` rather than repointing it, because a
consumer's standards live in the repository being worked on, where the agent
reads them for itself.

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
