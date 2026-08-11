---
---

Docs only, no release. This repository's own coding standards now live in the
repo (`docs/typescript-style.md`, `docs/doc-comments.md`) instead of behind an
absolute `~/.claude/skills/` path that does not exist on a CI runner or to a
review sub-agent. `CONTEXT.md` records the standards-in-repo /
procedures-in-skills boundary. No published API, behaviour, or shipped file
changes; consumers still supply their own `standardsDir`.
