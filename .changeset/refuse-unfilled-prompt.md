---
'@galosandoval/shopfloor': minor
---

A run refuses before spawning when its prompt was never filled in
(shopfloor#44).

**New failure mode: a prompt that previously ran now refuses.** Two things in
the prompt template fail the run among the pre-spawn preconditions, before any
`git` or `gh` probe and before a single token is spent:

- **`TODO(shopfloor)`** — the sentinel `shopfloor init` writes wherever it could
  not read a value off your project. The refusal names the lines it is on.
- **A `{{TOKEN}}` outside the six this package substitutes** — `{{ISSUE_NUMBER}}`,
  `{{ISSUE_TITLE}}`, `{{BRANCH}}`, `{{PR_DESCRIPTION_FILE}}`,
  `{{VERIFY_REPORT_FILE}}`, `{{SCREENSHOTS_DIR}}`. A misspelling, or a token that
  used to exist — `{{STANDARDS_DIR}}` is the live case. The refusal names each
  offender beside the table of real ones.

Both previously ran. An unrecognized token rendered as literal text, unchanged
and unreported, so an unfilled placeholder was indistinguishable from prose: a
consumer who skipped filling the environment block paid for a whole run that
then failed on a command their repository does not have. The refusal is the
design's last open item, and it is why `init` writes a sentinel rather than a
plausible default.

**Is the bump safe for you?** A template with no sentinel, carrying only the six
tokens spelled exactly as above, is unaffected. `npx shopfloor-doctor` reports
most of the rest without spending anything — but a green doctor is not proof,
because the run is the stricter check of the two: the doctor looks for the
sentinel only inside the environment fences and tolerates spaces and
lower-casing in a token, while the run refuses on the sentinel **anywhere** in
the prompt and on `{{ ISSUE_NUMBER }}` or `{{issue_number}}` as readily as on a
misspelling — the renderer substitutes none of them, so all three would have
reached the agent as literal text.

**The doctor's wording changed to match.** Its `prompt-tokens` check used to
report an unrecognized token as one that "renders as literal text, unchanged and
unreported"; that is no longer true of any run, so it now reports one that
"nothing substitutes, so a run refuses before spawning". Same check, same
pass/fail, new detail string — worth knowing only if you assert on the doctor's
text.

**What still does not refuse:** a _missing_ token. Leaving one out is a choice
this package does not second-guess — the doctor reports it, a run does not
refuse over it. And the check reads the template rather than the rendered
prompt, so a `{{...}}` that arrives inside an issue title is the issue's data
and never blocks the loop.

**New export: `evaluatePromptReadiness`** — the pure verdict, over prompt text
and a token table, for tooling that wants to ask before a run does.
