---
'@galosandoval/shopfloor': patch
---

Documentation only — no API, behaviour, or configuration change. The one thing
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
a consumer's own standards live in the repository being worked on — see the
`standardsDir` removal in this same release.
