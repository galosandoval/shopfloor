---
---

Docs only — no release. `README.md` was 1682 lines and had grown into a design
document: every consumer-facing table was surrounded by the argument for why the
decision was made that way, and that argument is already in `CONTEXT.md`, which
is where a reader is sent for it.

The reference survives intact — resolution order, the eight prompt tokens, both
result shapes, the six labels and the transition table, the five refusal kinds,
the doctor's checks and its stated blind spots, the removed-input shims, and the
bins — and each behaviour a consumer can trip over is stated in a line or two
instead of a section. The `Module layout` section is gone rather than trimmed:
it duplicated `CONTEXT.md`'s module map and named internals a consumer cannot
call. In its place is a compact export index, so nothing on the public surface
is undocumented.

No package behaviour changes.
