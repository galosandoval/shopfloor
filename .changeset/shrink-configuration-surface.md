---
'@galosandoval/shopfloor': minor
---

Shrink the configuration surface to an issue number, a prompt, and a token.

A run now resolves everything else in one documented order — explicit input →
environment variable → probe (`git`, `gh`) → package default:

```sh
CLAUDE_CODE_OAUTH_TOKEN=*** PROMPT_FILE=./prompt.md npx shopfloor-implement 123
```

- **`runPolicy` and every field in it are optional**, merging over the new
  exported `DEFAULT_RUN_POLICY` (150 turns, a 15-minute idle guard, no required
  env vars). With no model configured, `--model` is left off the invocation and
  the Claude CLI's own default applies.
- **GitHub Actions values are inferred**: branch from `GITHUB_REF_NAME` (else
  the current checkout), repository from `GITHUB_REPOSITORY`, and — for
  `postVerifyComment` — the commit from `GITHUB_SHA`, the run link from
  `GITHUB_SERVER_URL`/`GITHUB_RUN_ID`, and the PR from the head branch via `gh`.
  The issue title is read from the issue itself, so the prompt can't disagree
  with what it's implementing.
- **The four run outputs collapse into `outputDir`** (`OUTPUT_DIR`, defaulting
  to the OS temp dir), each still individually overridable. `screenshotsDir`
  stays repo-relative and issue-scoped, because those files get committed.
- **`cliVersion` and `wallClockMinutes` are no longer required.** Neither is
  enforced by anything — the README now says so instead of advertising a
  wall-clock ceiling the harness doesn't impose. Both survive as optional
  fields so enforcement can land additively.
- **`ANTHROPIC_API_KEY` is still stripped from the child environment
  unconditionally**, however the OAuth token was resolved.

Breaking:

- The public API narrows to `runImplementAgent`, `runPreflight`,
  `postVerifyComment`, `ImplementAgentError`, `evaluatePreflight`,
  `buildVerifyComment`, `DEFAULT_RUN_POLICY`, and the input/result types.
  `prepareClaudeInvocation`, `findMissingEnvVars`, `resolveIdleMs`,
  `resolveWallClockMs`, `parseClosingReferences`, `captureTranscript`,
  `findNewestSessionFile`, and the two run-policy env-var name constants are no
  longer exported — they are test seams, not API.
- `RunImplementAgentResult` gains `branch`, the branch the run resolved to.
- `buildVerifyComment`'s `runUrl` is optional; with none, the comment omits the
  run link rather than emitting a dead one.

Every other change is in the lenient direction: a previously-valid
configuration stays valid.
