---
'@galosandoval/shopfloor': minor
---

Verify two preconditions before spawning: the CLI version and the standards path.

**New failure mode — a misconfigured `standardsDir` now refuses the run.** A
non-empty `standardsDir` (`STANDARDS_DIR`) that does not resolve to a directory
fails before the Claude CLI spawns, naming the path, alongside the existing
required-env-var check. Previously the path was substituted into the prompt
unvalidated, so a wrong one was indistinguishable from a right one and the run
quietly instructed the agent to read nothing — producing work against no
standards at all. If your `standardsDir` is stale, runs that used to "pass"
will now fail immediately; check the path before upgrading. A relative path is
resolved against the run's `cwd`, where the agent itself reads it from. An
empty `standardsDir` still means "deliberately skip", silently, unchanged.

**`runPolicy.cliVersion` (`CLI_VERSION`) is now compared, not just recorded.**
The running `claude --version` is read before the spawn and returned on the run
result as the new `cliVersion` field, so a run's output names which CLI
produced it even when no pin is stated. A mismatch against the pin warns by
default and does not block; `runPolicy.cliVersionStrictness`
(`CLI_VERSION_STRICTNESS`) takes `'warn' | 'error' | 'off'`, where `'error'`
refuses before spawning and `'off'` skips the comparison for local dev.

A mismatch means a differing `major.minor` — the patch is ignored, since the
CLI surface this harness reads moves in minor releases and an exact pin would
fail runs over changes that cannot affect it. A `claude --version` that fails
or returns something unparseable never blocks a run at any strictness; a
`cliVersion` that isn't a readable semver doesn't block either, but warns
rather than disabling the check silently.
