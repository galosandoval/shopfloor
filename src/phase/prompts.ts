/**
 * The prompt a phase spawns with (shopfloor#47), keyed by phase because one
 * verb discovers the phase from the payload rather than being told which run
 * it is.
 *
 * **What ships is a shim, not a prompt.** The default names the phase, names
 * the issue and the branch, and says where the run's outputs go — then defers
 * to the bundled skills plugin for how to carry the work out. Procedure
 * already lives in skills (shopfloor#26), and a shipped prompt carrying it too
 * would put the same content in two places with no rule for which wins.
 * Environment — a consumer's install command, their gate, their seeded
 * database — is the ~60% of a real prompt this package still ships to nobody;
 * `shopfloor init` fills that block from the consumer's own project
 * (shopfloor#43), and a run refuses on it unfilled (shopfloor#44).
 *
 * Pure: a stated prompt and the default are both text, and choosing between
 * them needs no disk. Reading a consumer's `PROMPT_FILE` is the shell's.
 */

import { PHASES, type Phase } from '../trigger/classify'

/**
 * The shipped shim per phase. Typed `Record<Phase, string>` so adding a phase
 * to {@link PHASES} is a compile error here rather than a run that discovers
 * at spawn time that nothing was written for it.
 *
 * Every `{{TOKEN}}` in these is one `prepareClaudeInvocation` substitutes —
 * `evaluatePromptReadiness` refuses a prompt naming any other, and the shipped
 * default has no business being the one it refuses.
 */
export const DEFAULT_PHASE_PROMPTS: Record<Phase, string> = {
  implement: `# Implement issue #{{ISSUE_NUMBER}}

**{{ISSUE_TITLE}}**

Read the issue with \`gh issue view {{ISSUE_NUMBER}}\` and implement what it
asks for. You are on branch \`{{BRANCH}}\`; commit your work there.

How to carry the work out is the \`implement\` skill, from the plugin this run
already loaded. Follow this repository's own standards — \`CLAUDE.md\` and
whatever it points at.

## What this run must leave behind

- The implementation, committed on \`{{BRANCH}}\`.
- The pull request description, written to \`{{PR_DESCRIPTION_FILE}}\`.
- What you verified and how, written to \`{{VERIFY_REPORT_FILE}}\`.
- Any screenshots, saved under \`{{SCREENSHOTS_DIR}}\`.
`
}

export interface PhasePromptInput {
  phase: Phase
  /**
   * Prompts the caller stated, by phase — their own file's contents, normally.
   * A phase absent from this map falls back to {@link DEFAULT_PHASE_PROMPTS};
   * a phase present with nothing in it is a caller stating a prompt they never
   * filled, and refuses rather than silently falling back to the shim they
   * meant to replace.
   */
  stated?: Partial<Record<Phase, string | undefined>>
}

export type PhasePromptVerdict =
  { resolved: true; prompt: string } | { resolved: false; reason: string }

/**
 * The prompt for a discovered phase, or a refusal naming the phase.
 *
 * The refusal is what makes a phase with no prompt fail **at startup** rather
 * than at spawn time: a run that reaches the CLI with an empty prompt spends a
 * session discovering it has been told nothing, and the message it fails with
 * names none of what a maintainer has to add.
 */
export function resolvePhasePrompt(
  input: PhasePromptInput
): PhasePromptVerdict {
  const stated = input.stated?.[input.phase]

  if (stated !== undefined) {
    return stated.trim()
      ? { resolved: true, prompt: stated }
      : { resolved: false, reason: emptyStatedReason(input.phase) }
  }

  const shipped = DEFAULT_PHASE_PROMPTS[input.phase]

  return shipped?.trim()
    ? { resolved: true, prompt: shipped }
    : { resolved: false, reason: noPromptReason(input.phase) }
}

function emptyStatedReason(phase: Phase): string {
  return (
    `Refusing to start the ${phase} phase: a prompt was stated for it and is ` +
    'empty. Fill it in, or state nothing for this phase to run on the ' +
    'shipped shim.'
  )
}

function noPromptReason(phase: Phase): string {
  return (
    `Refusing to start the ${phase} phase: nothing resolves a prompt for it. ` +
    `The phases this package ships a prompt for are ${PHASES.join(', ')}; ` +
    `state one for "${phase}" to run it.`
  )
}
