#!/usr/bin/env node

/**
 * The refusal shim for the removed bin (shopfloor#51). `shopfloor-implement
 * <issue>` was replaced by `shopfloor-run-phase`, which takes no arguments
 * (shopfloor#47).
 *
 * **It ships rather than being deleted, for a reason particular to `npx`.** A
 * workflow step still running `npx --yes @galosandoval/shopfloor@1 shopfloor-implement 51`
 * against a package that no longer declares the bin does not stop: `npx` falls
 * through to the registry and runs whatever package is published under that
 * name — which is nobody's yet, and is a name anyone may claim. A shim that
 * exits non-zero is the difference between a migration a consumer reads and an
 * unpinned fetch of a stranger's code inside a fully-permissioned run.
 *
 * It runs nothing, reads nothing, and writes nothing.
 */

console.error(
  '`shopfloor-implement` was removed in 1.0.0 — the loop is one verb now, and ' +
    'its bin is `shopfloor-run-phase`.\n\n' +
    'It takes no arguments: the issue, the phase, and the actor come off the ' +
    'webhook payload at GITHUB_EVENT_PATH, and the branch is `agent/issue-<n>`. ' +
    'So the issue number this was called with, along with the slug pipeline, ' +
    'the `gh pr create` step, and the `gh issue edit` label swaps around it, all ' +
    'go — `runPhase` owns the branch, the pull request, and the issue state.\n\n' +
    'Put a setup-free `shopfloor-admit` job in front of it, keep your checkout ' +
    '(with a PAT) and your exit code, and run `npx shopfloor-init` to scaffold ' +
    'exactly that workflow.'
)

process.exit(1)

// A bin with nothing to import is still a module: without this the file is a
// script in TypeScript's eyes, and its `console` and `process` would be checked
// against the global scope every other file in this package has already claimed.
export {}
