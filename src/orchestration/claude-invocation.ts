/**
 * Pure invocation-assembly for a direct Claude Code CLI invocation (ported
 * from recipe-chat-v1's `agent/implement/claude-invocation.ts`, #540). No IO
 * here — {@link runImplementAgent} reads the prompt template and spawns the
 * subprocess; this module only computes what to spawn with.
 */

export interface ClaudeInvocationInput {
  /** Raw contents of the prompt template, with `{{PLACEHOLDER}}` tokens to render. */
  promptTemplate: string
  issueNumber: string
  issueTitle: string
  branch: string
  prDescriptionFile: string
  verifyReportFile: string
  screenshotsDir: string
  /** Claude model the headless agent runs — from the caller's `RunPolicyConfig`.
   *  Omitted leaves `--model` off the vector so the Claude CLI's own default
   *  applies, rather than pinning a model string here. */
  model?: string
  /** Fast-loop backstop cap on agent turns — from the caller's `RunPolicyConfig`. */
  maxTurns: number
  /** Claude Code plugin directories to load for this session only, one
   *  `--plugin-dir` occurrence each — the CLI's own skill discovery, rather
   *  than anything staged into the consumer's tree. Validated before the run
   *  reaches here (`evaluatePluginDirs`); this module only lays out flags.
   *  Omitted or empty leaves the flag off the vector entirely. */
  pluginDirs?: string[]
  /** Absolute path to the command-guard hook script (shopfloor#2). Given, the
   *  invocation carries a `--settings` payload wiring it as a `PreToolUse`
   *  hook over `Bash`, so the run's forbidden operations are refused at
   *  tool-call time rather than caught after the fact. Omitted leaves the
   *  session on the ambient settings alone. */
  commandGuardHookPath?: string
  /** What the previous iteration's quality gate said, from
   *  `evaluateIteration` (shopfloor#40). Appended to the rendered prompt, which
   *  is what makes a second spawn something other than a rerun of the first.
   *  Omitted on the first iteration and on every run with no gate stated, so
   *  the prompt stays byte-identical to a pre-loop run's. */
  iterationFeedback?: string
  /** Streams incrementally instead of staying silent until the whole session
   *  ends: a local idle-timeout needs that heartbeat to have any signal to
   *  watch. Omitted/false keeps the arg vector byte-identical to before this
   *  option existed. */
  streamOutput?: boolean
}

export interface ClaudeInvocation {
  /** Headless Claude CLI flags, in spawn order. */
  args: string[]
  /** The rendered prompt, passed separately so callers can wire it in as the
   *  trailing positional CLI argument without guessing where in `args` a
   *  multi-KB string would land. */
  prompt: string
}

/**
 * Renders `input.promptTemplate`'s `{{PLACEHOLDER}}` tokens against `input`'s
 * named fields and assembles the headless Claude CLI argument vector.
 */
export function prepareClaudeInvocation(
  input: ClaudeInvocationInput
): ClaudeInvocation {
  const substitutions: Record<string, string> = {
    ISSUE_NUMBER: input.issueNumber,
    ISSUE_TITLE: input.issueTitle,
    BRANCH: input.branch,
    PR_DESCRIPTION_FILE: input.prDescriptionFile,
    VERIFY_REPORT_FILE: input.verifyReportFile,
    SCREENSHOTS_DIR: input.screenshotsDir
  }

  const rendered = input.promptTemplate.replace(
    /\{\{(\w+)\}\}/g,
    (token, key) => (key in substitutions ? substitutions[key] : token)
  )

  // Appended rather than substituted into a placeholder: the feedback must
  // reach an iterating run whatever the consumer's template says, and a
  // template with no token for it would otherwise silently drop the one thing
  // that distinguishes this turn from the last.
  const prompt = input.iterationFeedback
    ? `${rendered}\n${input.iterationFeedback}\n`
    : rendered

  const args = [
    '--print',
    ...(input.model ? ['--model', input.model] : []),
    '--max-turns',
    String(input.maxTurns),
    // Safe because the containment boundary is the environment, not this
    // flag: a fully autonomous headless run has no human present to approve
    // tool calls, so permission prompts would just hang the run. Callers must
    // provide their own sandboxing (a disposable CI runner, a container).
    '--dangerously-skip-permissions',
    ...(input.pluginDirs ?? []).flatMap((dir) => ['--plugin-dir', dir])
  ]

  if (input.commandGuardHookPath) {
    // Inline JSON rather than a settings file: `--settings` accepts either,
    // and inline keeps this module pure — nothing to write, nothing to clean
    // up. Session-scoped, so the guard never leaks into a human's own
    // settings for the same checkout.
    args.push('--settings', guardSettingsJson(input.commandGuardHookPath))
  }

  if (input.streamOutput) {
    args.push(
      '--output-format',
      'stream-json',
      '--verbose',
      '--include-partial-messages'
    )
  }

  return { args, prompt }
}

/**
 * The `--settings` payload that arms the command guard: a `PreToolUse` hook on
 * `Bash` — the only tool that runs shell commands, and so the only one the
 * policy can classify. The hook script is quoted because it is a path being
 * spliced into a shell command line.
 */
function guardSettingsJson(hookScriptPath: string): string {
  return JSON.stringify({
    hooks: {
      PreToolUse: [
        {
          matcher: 'Bash',
          hooks: [{ type: 'command', command: `node "${hookScriptPath}"` }]
        }
      ]
    }
  })
}
