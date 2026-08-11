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
  /** Empty when a local run has no standards mount; the template's own text
   *  handles the skip, this module just substitutes the empty string. */
  standardsDir: string
  verifyReportFile: string
  screenshotsDir: string
  /** Claude model the headless agent runs — from the caller's `RunPolicyConfig`.
   *  Omitted leaves `--model` off the vector so the Claude CLI's own default
   *  applies, rather than pinning a model string here. */
  model?: string
  /** Fast-loop backstop cap on agent turns — from the caller's `RunPolicyConfig`. */
  maxTurns: number
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
    STANDARDS_DIR: input.standardsDir,
    VERIFY_REPORT_FILE: input.verifyReportFile,
    SCREENSHOTS_DIR: input.screenshotsDir
  }

  const prompt = input.promptTemplate.replace(/\{\{(\w+)\}\}/g, (token, key) =>
    key in substitutions ? substitutions[key] : token
  )

  const args = [
    '--print',
    ...(input.model ? ['--model', input.model] : []),
    '--max-turns',
    String(input.maxTurns),
    // Safe because the containment boundary is the environment, not this
    // flag: a fully autonomous headless run has no human present to approve
    // tool calls, so permission prompts would just hang the run. Callers must
    // provide their own sandboxing (a disposable CI runner, a container).
    '--dangerously-skip-permissions'
  ]

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
