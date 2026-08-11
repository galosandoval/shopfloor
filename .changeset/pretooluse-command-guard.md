---
'@galosandoval/shopfloor': minor
---

Block schema pushes, force-pushes, and amends at tool-call time.

`runImplementAgent` now arms a `PreToolUse` hook over `Bash` automatically: the
invocation carries an inline `--settings` payload pointing at a hook script
that ships with the package, and a forbidden command is refused with the reason
and the sanctioned alternative fed back to the agent. The three rules —
`prisma db push`, `git push --force` (and `--force-with-lease` /
`--force-if-includes` / `-f` / a leading-`+` refspec), and `git commit --amend`
— were prompt prose before, enforced only after the fact.

A run whose hook script can't be located beside the bundle now throws
`ImplementAgentError` instead of starting unguarded.

Adds `classifyCommand` to the public surface as the pure decision function
behind the hook, along with its `CommandVerdict` / `BlockedVerdict` types.
`prepareClaudeInvocation` gains an optional `commandGuardHookPath` input. No
configuration is required, and nothing changes for a caller that only uses the
documented API.
