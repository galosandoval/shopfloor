---
'@galosandoval/shopfloor': minor
---

Render the agent's `stream-json` output as readable job-log lines instead of raw JSONL.

A run streams with `--verbose --include-partial-messages` so the idle guard has a heartbeat, and every byte of that — including one JSON line per output token — went straight to the caller's job log. The log is the only place a human watches a headless run, so it was effectively unreadable.

The spawn shell now renders stdout: a session banner, the model's prose, one line per tool call naming the argument worth seeing (`⏺ Bash(npm test)`), its result or error under it, and a terminal line with turns, duration, and cost. Partial-message events are dropped, thinking is summarized by length, and long arguments and tool results are truncated.

New failure modes to know about:

- **stdout is no longer passed through verbatim.** Anything parsing this package's stdout as JSONL breaks. The verbatim record is unchanged — it is the transcript artifact (`transcriptFile`), which is where an audit should have been reading it from. stderr is still passed through untouched, and a stdout line that is not JSON still prints as it arrived.
- Rendering is a diagnostic and degrades rather than failing: an unparseable line prints raw, a line too long to buffer is dropped, and a throw in the renderer costs a log line rather than the run. Usage metering and the runaway guards are unaffected — the idle guard still reads the raw chunk before anything renders it.
