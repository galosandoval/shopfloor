# TypeScript Style Guidelines

**Guiding principle:** When you look at any given piece of code, you should be
able to tell what everything does. Names, structure, and size should make each
part self-explanatory without hunting through the file or jumping elsewhere.

React-specific guidance lives in [`docs/react-style.md`](./react-style.md); it
does not apply to this package, which ships no React.

## File Size Guidelines

These are soft guidelines to encourage readable, maintainable code (not hard
limits).

### Functions, methods, and classes

- **~80 lines** is a good time to consider extracting (helpers, private
  methods, smaller units)
- When a function/method grows large, consider:
  - Extracting helper functions or private methods **in the same file**, placed
    nearby
  - Breaking into smaller, single-responsibility functions
  - Using early returns to reduce nesting
- Prefer keeping extracted code in the same file; only move to a new file when
  it's reused elsewhere

## Code Colocation

- **Keep code close to where it's used** — Helper functions and sub-units
  should live near their consumers
- **Don't export unless needed elsewhere** — Keep functions unexported/private
  until they're actually used in other files
- **Only extract to separate files when reused** — If a function is only used
  in one place, keep it in the same file

## When Files Get Large

Extract in-file first: pull the long stretch into a named helper directly below
its caller. That keeps the code nearby and avoids a new file until something
else actually needs it.

If you notice a file exceeding these guidelines:

1. **First, check if the code is reused** — only extract to a separate file if
   it's used in multiple places
2. **Name the extracted unit for what it decides or produces**, not for where
   it came from — a helper called `parseArgs` earns its place; one called
   `handlePart2` does not
3. **Split by reason to change** — if one file is edited for several unrelated
   reasons, that's the seam, not the line count

## Rationale

The goal is local clarity: at any spot in the code, you can see what everything
does. Smaller files and functions are easier to read, simpler to test in
isolation, less prone to bugs, and more reusable.

---

Why this lives in the repo, and where it came from:
[`CONTEXT.md`](../CONTEXT.md#standards-in-repo-procedures-in-skills).
