---
'@galosandoval/shopfloor': patch
---

Documentation only — no API, behaviour, or configuration change.

The README told consumers to write their own prompt template but never said
what a template may reference. The six substituted tokens are now documented in
a new "The prompt template" section: `{{ISSUE_NUMBER}}`, `{{ISSUE_TITLE}}`,
`{{BRANCH}}`, `{{PR_DESCRIPTION_FILE}}`, `{{VERIFY_REPORT_FILE}}`, and
`{{SCREENSHOTS_DIR}}`. Only the first three were guessable from the rest of the
document; the other three are how a prompt learns where to write the artifacts
this package reads back afterwards, so a template that omitted them produced a
run with no PR description and nothing to post — with nothing anywhere saying
why.

The section also states the failure mode the substitution has always had: an
unrecognized token renders as literal text, unchanged and unreported. There is
no error for a misspelled placeholder, and none for one that used to exist —
which is the position `{{STANDARDS_DIR}}` is in as of its removal.

Also corrected: the reference-wiring link pointed at a repository name that
404s (`galosandoval/recipe-chat-v1`, twice more in code examples — the
repository is `galosandoval/recipe-chat`), and that reference workflow still
clones a standards directory, so following it now yields a refused run. The
pointer says so rather than reading as a working example.
