/**
 * **Refusal shims for inputs this package no longer accepts** (shopfloor#51).
 *
 * A removed input is not removed until a run that still states it says so. The
 * type removal only reaches a caller who typechecks against this package; the
 * failure this exists to prevent is a consumer's CI that still sets the
 * environment variable, or a JavaScript caller still passing the field — where a
 * plain deletion produces no type error, no runtime error, and a run that does
 * something other than what the caller asked for. `standardsDir` (shopfloor#27)
 * established the shape and this generalizes it: every field and variable
 * removed across the loop sequence is listed here, named in the refusal, and
 * paired with what replaced it.
 *
 * **Pure, and one table per call site.** The two lists are checked at different
 * seams and cannot be merged: `runPhase` refuses the inputs the *payload* now
 * decides, before it has decided them, while `resolveImplementConfig` — which
 * `runPhase` calls *with* those very values — can only refuse the ones no caller
 * of it ever legitimately states.
 *
 * **An empty value never refuses**, as it never did for `standardsDir`: unsetting
 * a variable by writing `FOO=` is a caller who has already migrated, and a
 * refusal there would punish the fix.
 */

import { ImplementAgentError } from './implement-error'

/** One removed input, and the sentence that tells a caller what to do instead. */
export interface RemovedInput {
  /** The config field, when the input had one. */
  field?: string
  /** The environment variable that stated it, when one did. */
  envVar?: string
  /** What replaced it — written for a consumer mid-upgrade, not as a changelog line. */
  replacement: string
}

export type RemovedInputsVerdict =
  { refused: false } | { refused: true; reason: string }

/**
 * The four values the webhook payload decides since shopfloor#47, plus the
 * prompt that is now keyed by phase. Stating any of them is stating what the
 * event already says — and a run that took a stated `issueNumber` would
 * implement one issue while admission had admitted another.
 *
 * `GITHUB_REPOSITORY` and `GITHUB_REF_NAME` are deliberately **not** here even
 * though `repo` and `branch` once resolved from them: the runner sets both on
 * every job, so refusing on their presence would refuse every run in GitHub
 * Actions. Only names this package asked a consumer to set are listed.
 */
export const PAYLOAD_OWNED_INPUTS: readonly RemovedInput[] = [
  {
    field: 'issueNumber',
    envVar: 'ISSUE_NUMBER',
    replacement:
      'the webhook payload names the issue, and `runPhase` reads it from ' +
      'GITHUB_EVENT_PATH. Nothing replaces it — delete it'
  },
  {
    field: 'issueTitle',
    envVar: 'ISSUE_TITLE',
    replacement:
      'the title is read from the issue itself, once, so the prompt and the ' +
      'pull request cannot name the work differently. Delete it'
  },
  {
    field: 'branch',
    envVar: 'BRANCH',
    replacement:
      'the branch is `agent/issue-<n>`, built from the issue the payload ' +
      'named (`agentBranchForIssue`, exported). Delete it, and delete the ' +
      'slug pipeline that used to compute it'
  },
  {
    field: 'repo',
    replacement: "the payload's repository is the run's repository. Delete it"
  },
  {
    field: 'promptTemplate',
    replacement:
      'prompts are keyed by phase now — pass `prompts: { implement: "…" }`, ' +
      'or keep PROMPT_FILE, which still applies to whichever phase the ' +
      'payload discovered. Unstated, the phase runs on the shim this package ' +
      'ships (`DEFAULT_PHASE_PROMPTS`)'
  }
]

/**
 * What no run resolves any more, whichever verb reached it. One entry, and it
 * is the precedent the rest of this module generalizes: skills reach the agent
 * through the CLI's own plugin discovery, so a directory path substituted into
 * a prompt has nothing left to mean.
 *
 * Either source refuses on its own rather than one taking precedence over the
 * other: a stated value is not a way to mask a set variable, and precedence
 * logic whose only purpose is to be deleted later is what a deprecation window
 * would have cost.
 */
export const REMOVED_RUN_CONFIG_INPUTS: readonly RemovedInput[] = [
  {
    field: 'standardsDir',
    envVar: 'STANDARDS_DIR',
    replacement:
      "skills now reach the agent through Claude Code's own plugin " +
      'discovery, not through a path substituted into the prompt. Unset it; ' +
      'an unstated `pluginDirs` / PLUGIN_DIRS loads the bundled skills ' +
      'plugin, and a stated one replaces that. Coding standards belong in the ' +
      'repository being worked on'
  }
]

/**
 * Refuse a caller still stating any of `removed`, naming every one it found
 * rather than the first: a consumer migrating an old workflow usually carries
 * several, and one refusal per run is one push per removed variable.
 */
export function evaluateRemovedInputs(input: {
  /** The caller's own config object, before anything this package settles is merged into it. */
  stated?: Record<string, unknown>
  env: Record<string, string | undefined>
  removed: readonly RemovedInput[]
}): RemovedInputsVerdict {
  const found = input.removed.filter(
    (entry) =>
      (entry.field !== undefined && Boolean(input.stated?.[entry.field])) ||
      (entry.envVar !== undefined && Boolean(input.env[entry.envVar]))
  )

  if (found.length === 0) return { refused: false }

  const lines = found.map(
    (entry) => `- ${nameOf(entry)} — ${entry.replacement}.`
  )

  return {
    refused: true,
    reason:
      `${found.length === 1 ? 'An input' : `${found.length} inputs`} this run ` +
      `states ${found.length === 1 ? 'was' : 'were'} removed in 1.0.0:\n` +
      `${lines.join('\n')}\n` +
      'Each is refused rather than ignored: a value this package silently ' +
      'dropped would leave a run doing something its caller did not ask for.'
  }
}

/**
 * The verdict as a refusal, for the two seams that have nothing to do about it
 * but throw. Here rather than written out at each of them, because a caller
 * copying the two-line shape is one `if` away from a shim that resolves the
 * verdict and then runs anyway.
 *
 * The cast is what the shim is *for*: these names are gone from the types, so
 * a config object no longer has anywhere to declare them, and the only way to
 * ask whether a caller stated one is to look.
 */
export function requireNoRemovedInputs(
  stated: object,
  env: Record<string, string | undefined>,
  removed: readonly RemovedInput[]
): void {
  const verdict = evaluateRemovedInputs({
    stated: stated as Record<string, unknown>,
    env,
    removed
  })

  if (verdict.refused) throw new ImplementAgentError(verdict.reason)
}

/** `` `field` / ENV_VAR ``, with whichever half the input had. */
function nameOf(entry: RemovedInput): string {
  const field = entry.field ? `\`${entry.field}\`` : undefined
  return [field, entry.envVar].filter(Boolean).join(' / ')
}
