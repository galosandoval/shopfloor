/**
 * The pure half of `shopfloor doctor` (shopfloor#39): already-gathered facts
 * about a consumer's setup in, a structured verdict out. No IO — `probeSetup`
 * runs `gh`, `claude`, and the filesystem reads and hands the results over,
 * and `parse-facts.ts` owns reading their raw output.
 *
 * **Why this exists.** A consumer must independently get right two secrets
 * (one a PAT carrying `workflow` scope), the label vocabulary, a workflow's
 * trigger wiring, a prompt carrying six exact placeholder tokens plus an
 * environment block, and a CLI pin. Every one is an untyped string binding —
 * the `standardsDir` failure shape, replicated across setup, and the reason
 * one transition in the live consumer's pipeline had never once fired. This
 * names each wrong binding instead of leaving it to be discovered by a run
 * that spends tokens first.
 *
 * **Three statuses, and only one of them fails.** A check that could not be
 * evaluated — an unreadable probe, a prompt this doctor was not pointed at —
 * reports `'unknown'` and does not fail the verdict, matching how every other
 * diagnostic in this package fails in the direction that costs least. An
 * unknown is loud in the report and quiet in the exit code.
 */

import { checkCliVersion } from '../guardrails/cli-version'
import {
  environmentBlockBody,
  firesOn,
  parseTriggers,
  promptTokensIn,
  type WorkflowTriggers
} from './parse-facts'

/**
 * The label vocabulary the loop transitions over: the harness's own run state,
 * and the process lifecycle either side of it. Fixed rather than configurable
 * — a name the harness does not own is a binding it cannot guarantee, and the
 * missing `ready-for-human` label is the concrete failure that argument came
 * from.
 */
export const REQUIRED_LABELS = [
  'ready-for-agent',
  'ready-for-human',
  'agent:implement',
  'agent:in-progress',
  'agent:blocked',
  'agent:exhausted'
] as const

/**
 * The scope the PAT is load-bearing for. `workflow` is what lets a token write
 * under `.github/workflows`; the separate reason the PAT exists at all — that
 * pushes made with `GITHUB_TOKEN` fire no downstream events — is not a scope,
 * and is checked against the workflow instead.
 */
const REQUIRED_PAT_SCOPES = ['workflow'] as const

/**
 * The tokens `prepareClaudeInvocation` substitutes, and the only ones it
 * substitutes. A prompt missing one silently loses the value; a prompt
 * carrying anything else renders it as literal text, unchanged and unreported
 * — which is exactly what `{{STANDARDS_DIR}}` became. Both directions are
 * checked here because neither produces an error anywhere else.
 */
export const PROMPT_TOKENS = [
  'ISSUE_NUMBER',
  'ISSUE_TITLE',
  'BRANCH',
  'PR_DESCRIPTION_FILE',
  'VERIFY_REPORT_FILE',
  'SCREENSHOTS_DIR'
] as const

/**
 * The events the loop is admitted to run on, each with why it is load-bearing
 * — a failure should say what is lost, not only what is absent.
 */
const ADMITTED_TRIGGER_EVENTS = [
  {
    event: 'issues',
    type: 'labeled',
    why: 'the human edge — nothing starts the loop without it'
  },
  {
    event: 'workflow_run',
    type: 'completed',
    why: 'the machine edge — without it this is a fan of triggers rather than a loop'
  }
] as const

/**
 * Fences marking the environment half of a prompt — the ~60% of a real prompt
 * that is local (gate commands, database URLs, seeded fixtures) and that this
 * package therefore never ships. HTML comments so they are invisible in
 * rendered markdown, and not `{{TOKEN}}` shaped so they never collide with the
 * substitution vocabulary above.
 */
export const ENVIRONMENT_BLOCK_START = '<!-- shopfloor:environment -->'
export const ENVIRONMENT_BLOCK_END = '<!-- /shopfloor:environment -->'

/**
 * What a scaffold leaves behind, so "unfilled" is machine-checkable rather
 * than inferred from prose. Refusing on a *missing* value is not enough — an
 * unfilled block reads exactly like a filled one to everything but a human.
 */
export const ENVIRONMENT_UNFILLED_SENTINEL = 'TODO(shopfloor)'

/** Stable ids — a report is diffed across runs, so these never churn. */
export type SetupCheckId =
  | 'gh-auth'
  | 'pat-workflow-scope'
  | 'repo-secrets'
  | 'label-vocabulary'
  | 'cli-version-pin'
  | 'prompt-tokens'
  | 'prompt-environment-block'
  | 'workflow-triggers'
  | 'workflow-run-prerequisites'

/**
 * `'unknown'` is held apart from `'fail'` throughout: a probe that answered
 * nothing has found no wrong binding, and reporting one would make a doctor
 * that cannot read `gh` indistinguishable from a repository that is
 * misconfigured.
 */
export type SetupCheckStatus = 'ok' | 'fail' | 'unknown'

export interface SetupCheck {
  id: SetupCheckId
  /** One line, human-facing — the report is the whole output of this command. */
  title: string
  status: SetupCheckStatus
  /** What was found, and for a failure, the binding to fix, named. */
  detail: string
}

export interface SetupVerdict {
  /** False when any check failed; unknowns alone never make a verdict fail. */
  ok: boolean
  checks: SetupCheck[]
  /** The failing subset, in check order — every wrong binding, named. */
  failures: SetupCheck[]
}

/** What the probe read. Every field carries `'unknown'` for a probe that answered nothing. */
export interface SetupFacts {
  /** Secret names the setup requires, as resolved — caller-stated, with package defaults. */
  requiredSecrets: string[]
  /** Which of {@link SetupFacts.requiredSecrets} is the PAT, by name. */
  patSecret: string
  ghAuth: 'authenticated' | 'unauthenticated' | 'unknown'
  /**
   * Scopes `gh auth status` reported for the token the operator is running as.
   * **Not the stored PAT's scopes** — those are unreadable, `gh secret list`
   * returns names alone. See {@link evaluateSetup} on what that costs.
   */
  ghTokenScopes: string[] | 'unknown'
  /** Secret names visible to this repository, repository- and organization-level alike. */
  repoSecrets: string[] | 'unknown'
  /** Label names `gh label list` returned. */
  repoLabels: string[] | 'unknown'
  /** Raw `claude --version` output; undefined when that probe answered nothing. */
  runningCliVersion?: string
  /** The pin a run policy states, if the caller stated one — nothing to compare against otherwise. */
  pinnedCliVersion?: string
  /** The prompt template's contents; null when there was no readable prompt to check. */
  promptTemplate: string | null
  /** The agent workflow's contents; null when there was no readable workflow. */
  workflow: string | null
  /** Path the workflow was read from, repo-relative — every workflow message names it. */
  workflowFile: string
  /** Workflow file names present on the default branch — `workflow_run` fires from nowhere else. */
  defaultBranchWorkflowFiles: string[] | 'unknown'
}

/**
 * Judge a gathered setup. Every check runs and reports, rather than stopping
 * at the first failure: a misconfigured setup costs a round trip to fix, and
 * naming one of four wrong bindings makes that four round trips.
 *
 * **Two blind spots, named rather than papered over.** The PAT's own scopes
 * cannot be read — a stored secret is write-only to everything but Actions —
 * so `pat-workflow-scope` judges the token the operator is running as and
 * infers the rest. And the PAT check against the workflow asks only whether it
 * is referenced at all, because deciding *which* step pushes would need the
 * job semantics a shallow read does not have. Both catch the common failure
 * (nobody made a PAT; nothing uses it) and neither is proof.
 */
export function evaluateSetup(facts: SetupFacts): SetupVerdict {
  const checks: SetupCheck[] = [
    checkGhAuth(facts),
    checkPatScope(facts),
    checkSecrets(facts),
    checkLabels(facts),
    checkCliPin(facts),
    checkPromptTokens(facts),
    checkEnvironmentBlock(facts),
    ...checkWorkflow(facts)
  ]

  const failures = checks.filter((check) => check.status === 'fail')
  return { ok: failures.length === 0, checks, failures }
}

/**
 * One check's three outcomes, so each check below reads as the decision it
 * makes rather than as nine repetitions of object assembly.
 */
function reports(id: SetupCheckId, title: string) {
  const as =
    (status: SetupCheckStatus) =>
    (detail: string): SetupCheck => ({ id, title, status, detail })
  return { ok: as('ok'), fail: as('fail'), unknown: as('unknown') }
}

/** What `required` asks for and `present` does not have. */
function missingFrom(
  required: readonly string[],
  present: readonly string[]
): string[] {
  return required.filter((name) => !present.includes(name))
}

function checkGhAuth(facts: SetupFacts): SetupCheck {
  const check = reports('gh-auth', 'gh is authenticated')
  if (facts.ghAuth === 'unknown') {
    return check.unknown(
      '`gh auth status` could not be run — is the GitHub CLI installed?'
    )
  }
  return facts.ghAuth === 'authenticated'
    ? check.ok('authenticated')
    : check.fail(
        'not authenticated — run `gh auth login`, or set GH_TOKEN to the ' +
          'token this setup should act as.'
      )
}

function checkPatScope(facts: SetupFacts): SetupCheck {
  const check = reports(
    'pat-workflow-scope',
    `local token carries ${REQUIRED_PAT_SCOPES.join(', ')} scope`
  )
  if (facts.ghTokenScopes === 'unknown') {
    return check.unknown('`gh auth status` reported no token scopes to read.')
  }

  const missing = missingFrom(REQUIRED_PAT_SCOPES, facts.ghTokenScopes)
  return missing.length === 0
    ? check.ok(facts.ghTokenScopes.join(', '))
    : check.fail(
        `missing scope(s): ${missing.join(', ')} — run \`gh auth refresh -s ` +
          `${missing.join(',')}\`. This reads the token you are running as, ` +
          `not the stored ${facts.patSecret}, whose scopes nothing can read: ` +
          'a PAT missing them cannot write under .github/workflows.'
      )
}

function checkSecrets(facts: SetupFacts): SetupCheck {
  const check = reports(
    'repo-secrets',
    `repository secrets: ${facts.requiredSecrets.join(', ')}`
  )
  if (facts.repoSecrets === 'unknown') {
    return check.unknown(
      '`gh secret list` could not be read for this repository.'
    )
  }

  const missing = missingFrom(facts.requiredSecrets, facts.repoSecrets)
  return missing.length === 0
    ? check.ok('all present')
    : check.fail(
        `missing: ${missing.join(', ')} — set with \`gh secret set <NAME>\`, ` +
          'or state REQUIRED_SECRETS if this setup names them differently. ' +
          `${facts.patSecret} is a PAT rather than the built-in GITHUB_TOKEN ` +
          'because a push made with GITHUB_TOKEN fires no downstream events, ' +
          'so the loop would never retrigger.'
      )
}

function checkLabels(facts: SetupFacts): SetupCheck {
  const check = reports('label-vocabulary', 'label vocabulary')
  if (facts.repoLabels === 'unknown') {
    return check.unknown(
      '`gh label list` could not be read for this repository.'
    )
  }

  const missing = missingFrom(REQUIRED_LABELS, facts.repoLabels)
  return missing.length === 0
    ? check.ok(`all ${REQUIRED_LABELS.length} present`)
    : check.fail(
        `missing: ${missing.join(', ')} — create with \`gh label create\`. ` +
          'A transition onto a label that does not exist fails silently, ' +
          'which is how one of these had never once fired.'
      )
}

function checkCliPin(facts: SetupFacts): SetupCheck {
  const check = reports('cli-version-pin', 'claude CLI matches the pin')
  const verdict = checkCliVersion({
    running: facts.runningCliVersion,
    pinned: facts.pinnedCliVersion,
    // Doctor reports rather than runs, so it always compares; how loudly a
    // *run* reacts stays the run policy's own `cliVersionStrictness`.
    strictness: 'warn'
  })

  if (verdict.status === 'match') {
    return check.ok(facts.runningCliVersion?.trim() ?? '')
  }
  if (verdict.status === 'mismatch') return check.fail(verdict.message)

  return check.unknown(
    verdict.message ??
      (facts.pinnedCliVersion
        ? '`claude --version` could not be read.'
        : 'no pin stated — state `runPolicy.cliVersion` / CLI_VERSION to compare against one.')
  )
}

function checkPromptTokens(facts: SetupFacts): SetupCheck {
  const check = reports('prompt-tokens', 'prompt placeholder tokens')
  if (facts.promptTemplate === null) {
    return check.unknown(
      'no prompt template to check — point PROMPT_FILE at the template this ' +
        'setup runs with.'
    )
  }

  const present = promptTokensIn(facts.promptTemplate)
  const missing = missingFrom(PROMPT_TOKENS, present)
  const unrecognized = present.filter(
    (token) => !PROMPT_TOKENS.includes(token as (typeof PROMPT_TOKENS)[number])
  )

  const problems: string[] = []
  if (missing.length > 0) {
    problems.push(
      `never substituted, so the run loses the value: ${missing.join(', ')}`
    )
  }
  if (unrecognized.length > 0) {
    problems.push(
      `renders as literal text, unchanged and unreported: ${unrecognized
        .map((token) => `{{${token}}}`)
        .join(', ')}`
    )
  }

  return problems.length === 0
    ? check.ok(`all ${PROMPT_TOKENS.length} present, none unrecognized`)
    : check.fail(problems.join('; '))
}

function checkEnvironmentBlock(facts: SetupFacts): SetupCheck {
  const check = reports(
    'prompt-environment-block',
    'prompt environment block is filled'
  )
  if (facts.promptTemplate === null) {
    return check.unknown('no prompt template to check.')
  }

  const body = environmentBlockBody(
    facts.promptTemplate,
    ENVIRONMENT_BLOCK_START,
    ENVIRONMENT_BLOCK_END
  )
  if (body === null) {
    // Unmarked, not unfilled: a hand-written prompt predating the fences may
    // carry its environment as plain prose, and calling that a failure would
    // fail every consumer who has one.
    return check.unknown(
      `no ${ENVIRONMENT_BLOCK_START} … ${ENVIRONMENT_BLOCK_END} block — ` +
        'fence the environment half of the prompt to make "unfilled" checkable.'
    )
  }
  if (body.trim() === '') return check.fail('the block is empty.')
  if (body.includes(ENVIRONMENT_UNFILLED_SENTINEL)) {
    return check.fail(
      `still carries ${ENVIRONMENT_UNFILLED_SENTINEL} — a run would spend ` +
        "tokens and then fail on this repository's own commands."
    )
  }
  return check.ok('filled')
}

/**
 * The two workflow checks, which share one parse: what the workflow is
 * triggered by, and — when it carries the machine edge — whether the
 * conditions `workflow_run` silently requires actually hold.
 */
function checkWorkflow(facts: SetupFacts): SetupCheck[] {
  const triggers =
    facts.workflow === null ? null : parseTriggers(facts.workflow)
  return [checkTriggers(facts, triggers), checkWorkflowRun(facts, triggers)]
}

function checkTriggers(
  facts: SetupFacts,
  triggers: WorkflowTriggers | null
): SetupCheck {
  const check = reports('workflow-triggers', 'workflow trigger events')
  if (triggers === null) {
    return check.unknown(
      `no readable workflow at ${facts.workflowFile} — state WORKFLOW_FILE if it lives elsewhere.`
    )
  }

  const missing = ADMITTED_TRIGGER_EVENTS.filter(
    (admitted) => !firesOn(triggers, admitted.event, admitted.type)
  )
  return missing.length === 0
    ? check.ok(
        ADMITTED_TRIGGER_EVENTS.map(
          (admitted) => `${admitted.event}.${admitted.type}`
        ).join(', ')
      )
    : check.fail(
        `${facts.workflowFile} is not wired to ` +
          missing
            .map((edge) => `${edge.event}.${edge.type} (${edge.why})`)
            .join(', or to ') +
          '.'
      )
}

/**
 * The prerequisites `workflow_run` carries and never states: it fires only
 * from a workflow file on the default branch, and a push made with
 * `GITHUB_TOKEN` fires no downstream event at all — so the PAT is load-bearing
 * on the machine edge rather than a convenience.
 */
function checkWorkflowRun(
  facts: SetupFacts,
  triggers: WorkflowTriggers | null
): SetupCheck {
  const check = reports(
    'workflow-run-prerequisites',
    'workflow_run prerequisites'
  )
  if (triggers === null) return check.unknown('no readable workflow to check.')
  if (!('workflow_run' in triggers.events)) {
    return check.unknown('the workflow declares no workflow_run trigger.')
  }

  /**
   * Kept apart by kind rather than recovered from the prose later: a check
   * that could not read the default branch has found nothing wrong, while
   * everything else here is an edge that will not fire.
   */
  const problems: Array<{ kind: 'unverified' | 'wrong'; detail: string }> = []

  if (facts.defaultBranchWorkflowFiles === 'unknown') {
    problems.push({
      kind: 'unverified',
      detail:
        'could not read the default branch, so it is unverified that ' +
        `${facts.workflowFile} exists there — workflow_run fires from nowhere else`
    })
  } else if (!onDefaultBranch(facts)) {
    problems.push({
      kind: 'wrong',
      detail:
        `${facts.workflowFile} is not on the default branch — a workflow_run ` +
        'trigger fires only from the default branch, so this edge would never fire'
    })
  }

  if (!facts.workflow?.includes(`secrets.${facts.patSecret}`)) {
    problems.push({
      kind: 'wrong',
      detail:
        `never references secrets.${facts.patSecret} — a push made with the ` +
        'built-in GITHUB_TOKEN fires no downstream events, so the loop would ' +
        'run once and stop'
    })
  }

  if (problems.length === 0) {
    return check.ok('on the default branch, and the PAT is referenced')
  }
  const detail = problems.map((problem) => problem.detail).join('; ')
  return problems.every((problem) => problem.kind === 'unverified')
    ? check.unknown(detail)
    : check.fail(detail)
}

/**
 * Whether the agent workflow's own file is present on the default branch.
 * Exported for `init`, which needs the same answer to know whether rewriting
 * the workflow could clear `workflow-run-prerequisites` — a merge is the one
 * half of that check no file it writes can fix.
 */
export function onDefaultBranch(facts: SetupFacts): boolean {
  if (facts.defaultBranchWorkflowFiles === 'unknown') return false
  const basename = facts.workflowFile.split('/').pop() ?? facts.workflowFile
  return facts.defaultBranchWorkflowFiles.includes(basename)
}

const STATUS_MARK: Record<SetupCheckStatus, string> = {
  ok: '✓',
  fail: '✗',
  unknown: '?'
}

/**
 * Render a verdict for a terminal. One line per check, failures repeated
 * underneath with what to fix — the report is this command's whole output, so
 * a reader should not have to hold nine lines in their head to find the two
 * that matter.
 */
export function formatSetupReport(verdict: SetupVerdict): string {
  const unknowns = verdict.checks.filter((check) => check.status === 'unknown')
  const lines = [
    'shopfloor doctor',
    '',
    ...verdict.checks.map(
      (check) => `${STATUS_MARK[check.status]} ${check.title}`
    ),
    ''
  ]

  if (verdict.failures.length > 0) {
    lines.push(`${verdict.failures.length} failing:`)
    for (const failure of verdict.failures) {
      lines.push(`- ${failure.id}: ${failure.detail}`)
    }
    lines.push('')
  }

  if (unknowns.length > 0) {
    lines.push(`${unknowns.length} unchecked (not a failure):`)
    for (const unknown of unknowns) {
      lines.push(`- ${unknown.id}: ${unknown.detail}`)
    }
    lines.push('')
  }

  lines.push(verdict.ok ? 'Setup looks correct.' : 'Setup is incomplete.')
  return lines.join('\n')
}
