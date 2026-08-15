---
'@galosandoval/shopfloor': minor
---

A run now reports what it cost (shopfloor#42).

**New field on the run result: `usage`.** The CLI's `stream-json` output already
flowed through the harness process — the idle guard reads it as a heartbeat —
and every byte of it was dropped. It is now parsed as it arrives, and
`RunImplementAgentResult.usage` carries the tokens (`inputTokens`,
`outputTokens`, `cacheCreationInputTokens`, `cacheReadInputTokens`), the
`costUsd` where the stream reports one, and a `source` field. `RunUsage` and
`TokenUsage` are exported.

This lands before the outer loop deliberately, not after it: the inner loop
shipped in 0.11.0 multiplies spend by N and bounds a run by attempts, which is a
ceiling on the wrong axis. Nothing in this package acts on the numbers yet — the
consumer is your CI glue, and evals.

**Read `source` before treating the numbers as a total.** `'reported'` means
every spawn reached its terminal `result` event and these are the CLI's own
figures. `'observed'` means at least one did not — a run a guard killed, or one
whose stream was unreadable — and the totals are then the harness's own sum over
the `assistant` messages it watched go by, each counted at the snapshot taken
when its message started. **That sum is not a total, and not uniformly a floor.**
`outputTokens` and `cacheCreationInputTokens` undercount, since the snapshot
precedes the message's final count and a run killed mid-message contributes
nothing. `inputTokens` and `cacheReadInputTokens` overcount, usually by a lot:
every turn re-sends the conversation, so summing across N turns counts the same
prefix up to N times. A run that iterated reports the sum across its iterations,
and degrades to `'observed'` if any single iteration did.

A `'observed'` total carries no `costUsd` even where one was seen: a cost covers
a whole session, and a complete price beside an incomplete token count is
exactly the misreading `source` exists to prevent.

**`ImplementAgentError` gained a `usage` field**, so a failed run reports its
spend too — a guard kill, a non-zero CLI exit, an exhausted attempt ceiling, and
a run that committed nothing all spent real tokens and all leave by throwing. It
is `undefined` only for a failure that refused before the spawn.

**No new failure mode.** Metering never fails a run: a malformed or unrecognized
line is skipped, and a run whose stream said nothing about usage reports zeroes
with `source: 'observed'` rather than absence — so "free" is never confused with
"unmeasured".

Two things to know if you depend on the surrounding behaviour. `usage` is
non-optional on `RunImplementAgentResult`, so a hand-built result object (a test
double, say) will not typecheck until it carries one. And `SpawnClaudeResult`
gained the same field — internal, but it is what the orchestrator's wiring tests
construct.
