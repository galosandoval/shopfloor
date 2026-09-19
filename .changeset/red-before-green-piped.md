---
'@galosandoval/shopfloor': patch
---

Recognize a red test run whose exit status a pipe swallowed.

`red-before-green` graded RED solely off the tool call's exit status, so an
agent that ran `bun run test 2>&1 | tail -30` (or appended `; echo done`)
reported success for a genuinely failing suite and was graded as though it had
never gone red — blocking a run that held the process. The invariant now also
reads a test runner's own failure summary out of the captured output, and only
under a command that already matched the gate patterns.
