---
'@galosandoval/shopfloor': minor
---

Label vocabulary + pure state transition table, with verify-and-refuse at
startup (shopfloor#45).

**What breaks.** A run against a repository missing any of the six labels now
**fails before the spawn**, naming every one that is absent, where it
previously started and silently skipped the transition later. So does a run
whose `gh label list` cannot be read at all — that refusal says "could not be
read" rather than naming labels, because an unauthenticated `gh` and an
unconfigured repository are different things to go fix. If you are on `0.10.x`
and have never run `npx shopfloor-init`, expect this to fail your next run:
`npx shopfloor-doctor` shows the gap, `npx shopfloor-init` creates what is
missing. This is deliberate. In the live consumer, a workflow step swapping
`ready-for-agent` for `ready-for-human` had failed on _every_ successful run
since it was written — the label did not exist and `|| true` swallowed it — so
a transition the pipeline claimed to make had never once happened.

`runPreflight` fails the same way, and for the same reason: it applies the
`refused` row, and it is a public entry point `runImplementAgent` never calls,
so a job running it as its own CI step inherits none of the run's startup
checks. It now verifies the vocabulary as its first act — before it reads the
issue — and **throws** `ImplementAgentError` rather than returning a refused
verdict. The two are different failures: a verdict says the issue must not be
implemented and is answered by labelling it, which is exactly the write an
unconfigured repository cannot be trusted with. If you call `runPreflight`
against a repository lacking a label, expect a throw where you previously got a
verdict — and previously got a label transition that silently did not happen.
A job running preflight and the run pays for the `gh label list` probe twice.

The check **verifies and never creates**: creating labels is a durable write to
a shared human workspace, and it stays with `init`, at a moment a human asked
for it. It is the last precondition before the CLI probe, so every local check
gets to refuse for free first.

**Also new to a preflight refusal.** `runPreflight` no longer carries
`agent:implement` / `agent:blocked` as string literals; it applies the
`refused` row of the transition table, which additionally sets
`ready-for-human` and drops `ready-for-agent`. It now reads the issue's labels
(on the `gh issue view` it already made) rather than assuming them, so it never
re-adds a label the issue already has, and a `gh` failure there surfaces
instead of being swallowed.

**Its comment text changed, and the old one was wrong.** A refusal used to say
"re-add `agent:implement` to retry". The scaffolded workflow triggers on
`ready-for-agent`, and GitHub fires `issues.labeled` only when a label is
_added_ — so following that instruction relabelled the issue without
retriggering anything. It now names `ready-for-agent` (exported as
`ENTRY_LABEL`) and states the labels the transition left behind.

**New exports.** `LABEL_VOCABULARY` and `REQUIRED_LABELS` move out of the
doctor module onto their own — same names, same values, still exported from the
package root, so no import changes. Alongside them: `ENTRY_LABEL`,
`applyLabelTransition`
(the `gh` shell), the pure `evaluateLabelTransition` with `TRANSITION_TABLE`
and `RUN_OUTCOMES`, and `evaluateLabelVocabulary` /
`runLabelVocabularyCheck` behind the new precondition.

Every outcome the harness can produce has exactly one row, `ready-for-human`
included — it is set by every terminal outcome, whatever the run produced. Each
row is a target set rather than a list of edits, so applying one twice writes
nothing the second time, and labels outside the vocabulary are never touched.
This package applies exactly one row itself today (`refused`); `started`,
`succeeded`, `exhausted`, and `failed` are yours to apply from CI glue, which
is what the exports are for.
