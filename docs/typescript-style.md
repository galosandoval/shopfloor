# TypeScript & React Style Guidelines

**Guiding principle:** When you look at any given piece of code, you should be able to tell what everything does. Names, structure, and size should make each part self-explanatory without hunting through the file or jumping elsewhere.

## File Size Guidelines

These are soft guidelines to encourage readable, maintainable code (not hard limits).

### React Components

- **100–125 lines** is a good time to consider extracting per component file
- When a component grows beyond this, consider:
  - Extracting sub-components (keep them in the same file unless reused elsewhere)
  - Moving logic to custom hooks
  - Splitting into smaller, focused pieces

### Functions, methods, and classes

- **~80 lines** is a good time to consider extracting (helpers, private methods, smaller units)
- When a function/method grows large, consider:
  - Extracting helper functions or private methods **in the same file**, placed nearby
  - Breaking into smaller, single-responsibility functions
  - Using early returns to reduce nesting
- Prefer keeping extracted code in the same file; only move to a new file when it's reused elsewhere

## Code Colocation

- **Keep code close to where it's used** - Helper functions, hooks, and sub-components should live near their consumers
- **Don't export unless needed elsewhere** - Keep functions unexported/private until they're actually used in other files
- **Only extract to separate files when reused** - If a function is only used in one place, keep it in the same file

## When Files Get Large

Use the **Extract** command (`/extract` or via the commands palette) to cut down long components, methods, or functions by extracting in-file; it keeps code nearby and avoids new files unless reused.

If you notice a file exceeding these guidelines:

1. **First, check if code is reused** - Only extract to separate files if the code is used in multiple places
2. **Extract custom hooks** - Move stateful logic and side effects into dedicated hooks (in the same file first, separate file only if reused)
3. **Create sub-components** - Split UI into smaller pieces, keeping them in the same file unless reused
4. **Consider composition** - Use component composition patterns

## Rationale

The goal is local clarity: at any spot in the code, you can see what everything does. Smaller files and functions support that by:

- Easier to read and understand
- Simpler to test in isolation
- Less prone to bugs
- More reusable across the codebase

---

Carried over verbatim from the author's personal `coding-standards` skill in
[galosandoval/skills](https://github.com/galosandoval/skills). The React
sections are kept as written rather than trimmed to this package's stack, so
the two copies stay diffable. Why this lives in the repo:
[`CONTEXT.md`](../CONTEXT.md#standards-in-repo-procedures-in-skills).
