---
---

Docs only, no release. This repository's own coding standards now live in the
repo (`docs/typescript-style.md`, `docs/doc-comments.md`) instead of behind an
absolute `~/.claude/skills/` path that does not exist on a CI runner or to a
review sub-agent. `CONTEXT.md` records the standards-in-repo /
procedures-in-skills boundary, and settles the files' provenance once so each
doc doesn't carry its own attribution footer.

The React half of the style guide moved to `docs/react-style.md`, which marks
itself non-binding on this package — it ships no React, and the review
sub-agent reads every standards doc in the repo as enforceable. What remains in
`docs/typescript-style.md` applies to this stack, and its extraction guidance
no longer points at an editor command a headless run cannot invoke.

No published API, behaviour, or shipped file changes; consumers still supply
their own `standardsDir`, and no doc in this repo is shipped to them.
