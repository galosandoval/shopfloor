/**
 * The pure half of `shopfloor init` (shopfloor#43): a setup verdict and the
 * project's own facts in, the list of writes out. `doctor` says what is wrong;
 * this says what to do about it, and `run-init.ts` is the only half that
 * touches the repository.
 *
 * **It plans from the verdict, so it writes only what is missing.** That is
 * what makes the command re-runnable rather than merely idempotent-by-luck: a
 * second run on a configured repository plans nothing, because every check the
 * writers address already passes.
 *
 * **Three things it will not do, all deliberate.** It never plans a write over
 * a file whose contents it cannot account for — an existing prompt with no
 * environment fences carries its environment as prose, and rewriting it would
 * destroy the one thing this command exists to fill. It never plans a write
 * that would change nothing: re-deriving a sentinel this same command wrote
 * would ask the operator to approve an overwrite on every run, forever. And it
 * never plans a label creation from a read that failed: `unknown` is not
 * `missing`, and creating six labels because `gh` was unreachable is a durable
 * write to a shared human workspace made on no evidence.
 */

import { environmentBlockBody } from './parse-facts'
import {
  buildEnvironmentBlock,
  buildPromptScaffold,
  buildWorkflowScaffold,
  type ProjectFacts
} from './scaffold'
import {
  LABEL_VOCABULARY,
  type LabelDefinition
} from '../issue-state/vocabulary'
import {
  ENVIRONMENT_BLOCK_END,
  ENVIRONMENT_BLOCK_START,
  ENVIRONMENT_UNFILLED_SENTINEL,
  onDefaultBranch,
  type SetupCheck,
  type SetupCheckId,
  type SetupFacts,
  type SetupVerdict
} from './setup'

export interface InitInput {
  /** What `probeSetup` read — the content half of every decision here. */
  facts: SetupFacts
  /** What `evaluateSetup` judged — the trigger half: nothing is written for a passing check. */
  verdict: SetupVerdict
  /** The project's lockfile and scripts, for filling the environment block. */
  project: ProjectFacts
  /** Repository-relative path the prompt is scaffolded at. */
  promptFile: string
  /** This package's own version, for pinning what the scaffolded workflow invokes. */
  packageVersion?: string
}

/**
 * Create the labels the vocabulary requires and the repository does not have.
 * Carries each label's whole definition rather than its name: the writer is a
 * `gh` call, and a name alone would have it create six labels whose colour and
 * meaning GitHub picks.
 */
export interface CreateLabelsAction {
  kind: 'create-labels'
  labels: LabelDefinition[]
  why: string
}

export interface WriteFileAction {
  kind: 'write-file'
  /** Repository-relative. */
  file: string
  contents: string
  /**
   * `'overwrite'` is the shell's cue to ask before writing. Kept on the plan
   * rather than discovered by the writer, so "this would destroy something"
   * is a property of the decision and is visible in the printed plan.
   */
  mode: 'create' | 'overwrite'
  why: string
}

export type InitAction = CreateLabelsAction | WriteFileAction

/** Something `init` could have fixed and declined to, with what the operator should do. */
export interface InitSkip {
  /** The file or vocabulary left alone, named as the plan names it elsewhere. */
  what: string
  why: string
}

export interface InitPlan {
  /** In execution order: labels first, then files. */
  actions: InitAction[]
  skipped: InitSkip[]
  /** Failing checks no writer here addresses — secrets, auth, the CLI pin. */
  unfixable: SetupCheck[]
  /** True when a run would write nothing at all. */
  noop: boolean
}

/**
 * Decide what `init` writes. Every branch below reads the verdict for whether
 * to act and the facts for what to write: the verdict alone cannot say *which*
 * labels are missing without parsing its own prose, and the facts alone would
 * re-implement the judgement `doctor` already made.
 */
export function planInit(input: InitInput): InitPlan {
  const actions: InitAction[] = []
  const skipped: InitSkip[] = []
  /** Check ids these actions address, so `unfixable` is what is genuinely left. */
  const addressed = new Set<SetupCheckId>()

  const labels = planLabels(input)
  record(labels)

  const prompt = planPrompt(input)
  record(prompt)

  const workflow = planWorkflow(input)
  record(workflow)

  return {
    actions,
    skipped,
    unfixable: input.verdict.failures.filter(
      (failure) => !addressed.has(failure.id)
    ),
    noop: actions.length === 0
  }

  function record(step: PlannedStep): void {
    if (step.action) actions.push(step.action)
    if (step.skip) skipped.push(step.skip)
    if (step.action) for (const id of step.addresses) addressed.add(id)
  }
}

/** One decision's three possible outcomes: write it, decline it, or neither. */
interface PlannedStep {
  action?: InitAction
  skip?: InitSkip
  /** Checks the action makes pass — empty when there is no action. */
  addresses: SetupCheckId[]
}

function checkFor(verdict: SetupVerdict, id: SetupCheckId): SetupCheck {
  const check = verdict.checks.find((candidate) => candidate.id === id)
  if (!check) throw new Error(`evaluateSetup produced no ${id} check`)
  return check
}

/**
 * Whether something this would write still carries the scaffold's sentinel —
 * the one question three separate decisions here turn on, so it is one concept
 * rather than three spellings of the same `includes`.
 */
function unfilled(contents: string): boolean {
  return contents.includes(ENVIRONMENT_UNFILLED_SENTINEL)
}

function planLabels({ facts, verdict }: InitInput): PlannedStep {
  const check = checkFor(verdict, 'label-vocabulary')
  if (check.status === 'ok') return { addresses: [] }
  if (facts.repoLabels === 'unknown') {
    return {
      addresses: [],
      skip: {
        what: 'label vocabulary',
        why:
          "the repository's labels could not be read, and creating six labels " +
          'on no evidence is a durable write to a shared workspace. Fix `gh` ' +
          'and re-run.'
      }
    }
  }

  const present = facts.repoLabels
  return {
    addresses: ['label-vocabulary'],
    action: {
      kind: 'create-labels',
      labels: LABEL_VOCABULARY.filter((label) => !present.includes(label.name)),
      why: 'a transition onto a label that does not exist fails silently.'
    }
  }
}

/**
 * The prompt: scaffolded when there is none, rewritten when its tokens are
 * wrong, and — the two cases worth stating — **left alone** when there is
 * nothing a rewrite could improve.
 *
 * A rewrite keeps an already-filled environment block verbatim rather than
 * rebuilding it, because a prompt whose only fault is a missing token would
 * otherwise have a human's environment replaced by whatever this can read,
 * which on an unreadable project is the sentinel. And an unfilled block is
 * only rewritten when the rebuild would actually fill it: re-deriving the same
 * sentinel would put an overwrite prompt in front of the operator on every
 * single run, over a file `init` itself wrote.
 */
function planPrompt(input: InitInput): PlannedStep {
  const { facts, project, promptFile } = input

  if (facts.promptTemplate === null) {
    const contents = buildPromptScaffold(project)
    return {
      addresses: promptChecksFixedBy(contents),
      action: {
        kind: 'write-file',
        file: promptFile,
        contents,
        mode: 'create',
        why: 'the run has no prompt to render.'
      }
    }
  }

  const body = environmentBlockBody(
    facts.promptTemplate,
    ENVIRONMENT_BLOCK_START,
    ENVIRONMENT_BLOCK_END
  )
  if (body === null) {
    return leaveAlone(
      promptFile,
      'it carries no environment fences, so its environment is prose this ' +
        'command cannot locate — and rewriting it would destroy the one thing ' +
        'init exists to fill. Fence it, or move it aside and re-run.'
    )
  }

  return planPromptRewrite(input, body)
}

/**
 * What a prompt write actually makes pass. A block this project could not fill
 * still leaves `prompt-environment-block` failing, by design — the sentinel is
 * the point — and claiming that check fixed would drop it from the report's
 * "still yours to fix".
 */
function promptChecksFixedBy(contents: string): SetupCheckId[] {
  return unfilled(contents)
    ? ['prompt-tokens']
    : ['prompt-tokens', 'prompt-environment-block']
}

/** A decision not to write, and what the operator does instead. */
function leaveAlone(what: string, why: string): PlannedStep {
  return { addresses: [], skip: { what, why } }
}

/**
 * The rewrite half, over a prompt that exists and whose environment block this
 * could find: whether there is anything a rewrite would improve, and if so
 * what it keeps.
 */
function planPromptRewrite(input: InitInput, body: string): PlannedStep {
  const { verdict, project, promptFile } = input
  const filled = body.trim() !== '' && !unfilled(body)
  const tokens = checkFor(verdict, 'prompt-tokens')
  if (tokens.status === 'ok' && filled) return { addresses: [] }

  const rebuilt = buildEnvironmentBlock(project)
  if (tokens.status === 'ok' && unfilled(rebuilt)) {
    // Nothing to fix but the block, and this cannot fix it either.
    return leaveAlone(
      promptFile,
      `its environment block still carries ${ENVIRONMENT_UNFILLED_SENTINEL}, ` +
        'and this project states nothing that would fill it — a rewrite ' +
        'would produce the same sentinel. Fill it by hand.'
    )
  }

  const environment = filled
    ? `${ENVIRONMENT_BLOCK_START}${body}${ENVIRONMENT_BLOCK_END}`
    : rebuilt
  const contents = buildPromptScaffold(project, environment)

  return {
    addresses: promptChecksFixedBy(contents),
    action: {
      kind: 'write-file',
      file: promptFile,
      contents,
      mode: 'overwrite',
      why: [
        tokens.status === 'fail' ? tokens.detail : undefined,
        filled
          ? 'Your environment block is kept exactly as it is.'
          : 'Its environment block is refilled from this project.'
      ]
        .filter(Boolean)
        .join(' ')
    }
  }
}

/**
 * The workflow: scaffolded when there is none, rewritten when its trigger
 * wiring is wrong or it never references the PAT.
 *
 * The PAT half is read off the facts rather than off
 * `workflow-run-prerequisites`, because that check's other half — the file
 * being on the default branch — is a merge, and no file this command writes
 * can fix it. Rewriting a correct workflow to clear a failure about where it
 * lives would be a write that changed nothing, so that check counts as
 * addressed only for a workflow already merged: an unmerged one stays in the
 * report, where "merge it" is the operator's next step.
 *
 * `workflow-unfilled` is never claimed. The scaffold's sentinels are values
 * this command declined to guess, so a write that emits them has not fixed
 * them — the check stays failing, which is the whole reason it exists.
 */
function planWorkflow({
  facts,
  verdict,
  promptFile,
  packageVersion
}: InitInput): PlannedStep {
  const contents = buildWorkflowScaffold({
    patSecret: facts.patSecret,
    promptFile,
    ...(facts.pinnedCliVersion ? { cliVersion: facts.pinnedCliVersion } : {}),
    ...(packageVersion ? { packageVersion } : {})
  })
  const addresses: SetupCheckId[] = onDefaultBranch(facts)
    ? ['workflow-triggers', 'workflow-run-prerequisites']
    : ['workflow-triggers']

  if (facts.workflow === null) {
    return {
      addresses,
      action: {
        kind: 'write-file',
        file: facts.workflowFile,
        contents,
        mode: 'create',
        // The merge rides on the action that creates the need for it. With no
        // workflow on disk `workflow-run-prerequisites` reports unknown rather
        // than failing, so nothing in the report would otherwise say that the
        // machine edge stays dead until this file is on the default branch.
        why: onDefaultBranch(facts)
          ? 'nothing triggers the loop without it.'
          : 'nothing triggers the loop without it. Merge it to the default ' +
            'branch — a workflow_run trigger fires from nowhere else, so the ' +
            'machine edge stays dead until it is there.'
      }
    }
  }

  const triggers = checkFor(verdict, 'workflow-triggers')
  const referencesPat = facts.workflow.includes(`secrets.${facts.patSecret}`)
  if (triggers.status !== 'fail' && referencesPat) return { addresses: [] }

  return {
    addresses,
    action: {
      kind: 'write-file',
      file: facts.workflowFile,
      contents,
      mode: 'overwrite',
      why: referencesPat
        ? triggers.detail
        : `it never references secrets.${facts.patSecret}, so a push it makes ` +
          'fires no downstream event and the loop runs once.'
    }
  }
}

/**
 * One action, named the way every report here names it. The single spelling:
 * the plan, the confirmation prompt, the applied list, and the failure lines
 * all render an action through this, so none of them drifts from the others.
 */
export function describeAction(action: InitAction): string {
  return action.kind === 'create-labels'
    ? `create ${action.labels.length} label(s): ${action.labels
        .map((label) => label.name)
        .join(', ')}`
    : `${action.mode} ${action.file}`
}

/**
 * Render a plan for a terminal, before anything is written. The operator is
 * being asked to approve durable writes to their own repository, so the plan
 * they approve is the plan they can read — every action with the reason it is
 * in the plan, rather than a bare list of paths.
 */
export function formatInitPlan(plan: InitPlan): string {
  const lines = ['shopfloor init', '']

  if (plan.noop) {
    lines.push(
      'Nothing to do — every binding this command writes is already correct.'
    )
  } else {
    lines.push('Will write:')
    for (const action of plan.actions) {
      lines.push(`- ${describeAction(action)} — ${action.why}`)
    }
  }

  if (plan.skipped.length > 0) {
    lines.push('', 'Left alone:')
    for (const skip of plan.skipped) lines.push(`- ${skip.what}: ${skip.why}`)
  }

  if (plan.unfixable.length > 0) {
    lines.push('', 'Still yours to fix — this command cannot:')
    for (const check of plan.unfixable) {
      lines.push(`- ${check.id}: ${check.detail}`)
    }
  }

  return lines.join('\n')
}
