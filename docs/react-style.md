# React Style Guidelines

**Not binding on this package.** `@galosandoval/shopfloor` is a library plus a
thin bin and ships no React. This file is kept so the author's TypeScript and
React standards stay in one place across repositories; a reviewer working on
this repository should read
[`docs/typescript-style.md`](./typescript-style.md) instead and treat nothing
here as a rule to enforce.

## File Size Guidelines

These are soft guidelines to encourage readable, maintainable code (not hard
limits).

### Components

- **100–125 lines** is a good time to consider extracting per component file
- When a component grows beyond this, consider:
  - Extracting sub-components (keep them in the same file unless reused
    elsewhere)
  - Moving logic to custom hooks
  - Splitting into smaller, focused pieces

## Code Colocation

- **Keep code close to where it's used** — hooks and sub-components should live
  near their consumers
- **Only extract to separate files when reused** — a component used in one
  place stays in the file that uses it

## When Components Get Large

1. **First, check if the code is reused** — only extract to a separate file if
   it's used in multiple places
2. **Extract custom hooks** — move stateful logic and side effects into
   dedicated hooks (same file first, separate file only if reused)
3. **Create sub-components** — split UI into smaller pieces, keeping them in
   the same file unless reused
4. **Consider composition** — use component composition patterns

---

Where this came from:
[`CONTEXT.md`](../CONTEXT.md#standards-in-repo-procedures-in-skills).
