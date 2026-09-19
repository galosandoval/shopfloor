# Versioning and releases

How a change gets from a pull request to a published version. The rule in
[`CLAUDE.md`](./CLAUDE.md) is the short form; this is the whole of it.

## Every PR carries a changeset

`npx changeset` — CI fails a PR that has none. A PR that deliberately ships
nothing — docs, CI config, tests — records an explicit empty one,
`npx changeset --empty`, so "this doesn't release" is on the record rather than
inferred from silence. Write the body for a consumer deciding whether the bump
is safe, naming new failure modes and what breaks, not just what was added.

Since `1.0.0`, semver means what it says: a breaking change is a major, and
"minor is additive" is a promise rather than the caveat it was pre-`1.0.0`.
Consumers still exact-pin, and that is their call, not a licence to break a
minor.

## You write changesets; CI writes versions

A PR of yours never carries a version bump — `npm run version:packages` is not a
step you run before merging. On a push to `main`, `changesets/action` does one
of two things:

- **Unconsumed changesets exist.** It opens or updates a **"Version Packages"
  PR** carrying the bump and the `CHANGELOG.md` entry. Nothing publishes.
- **`main` is already bumped**, because you merged that PR. It publishes to npm
  and pushes the tag.

So releasing is two merges, and the second one is a button. A merge carrying
only empty changesets produces no Version Packages PR at all, which is the
correct no-op.

`npm run version:packages` still exists for previewing a bump locally. Don't
commit what it writes — a branch carrying a bump and no changesets is the one
shape the PR check reads as the bot's own PR.

## Why it is shaped this way

**The manual step was the bug.** An earlier rule made the bump part of the PR:
run `version:packages` before merging, and merging publishes. That is what let
`1.0.0` ship four times over. A PR merged with its changesets unconsumed,
`changeset publish` found the version already on npm, and reported nothing to
publish — exit 0, no release, no complaint. A step a human has to remember is
not a release process, and a CI check that accepts silence will get silence.

**The release job writes a branch and a pull request, never `main`.** This is
the load-bearing detail. It means `main`'s ruleset needs no bypass actor —
which matters concretely: GitHub Actions **cannot** be a ruleset bypass actor on
a user-owned repository (the API refuses it with "must be part of the ruleset
source or owner organization"), so any design where CI pushes to `main` directly
would need a stored PAT or a deploy key. This one needs no secret beyond
`GITHUB_TOKEN`.

**Publishing is OIDC trusted publishing** — no `NPM_TOKEN` is stored anywhere.
That is why the release job installs `npm@^11.5.1` rather than trusting the
npm that node 24 bundles, and why it sets `NPM_CONFIG_PROVENANCE` rather than relying on
npm's trusted-publisher default.

## Do not make `verify` a required status check

A pull request opened with `GITHUB_TOKEN` does not trigger workflows, so the
Version Packages PR would never report a `verify` run and could never be merged.

That PR-time checks are currently unenforced — the ruleset's one required
context is `release`, which is skipped on pull requests and so always counts as
passing — is a real gap. It is a separate one, and this is not its fix.
