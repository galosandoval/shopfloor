/**
 * Pure trigger classification (shopfloor#46): given the **raw webhook
 * payload** — the contents of `$GITHUB_EVENT_PATH`, unread and
 * undestructured — decide which phase this event starts, on which issue, on
 * whose behalf. Or decide that it starts nothing.
 *
 * **Why the raw payload.** Today the consumer's YAML destructures the webhook
 * into `if:` expressions and `env:` blocks before anything typed can see it,
 * so which event means which phase is knowledge that can be neither typed nor
 * tested. Passing the payload whole moves that knowledge into a function with
 * fixtures behind it.
 *
 * **Rejected: a provider-neutral event type** (design §2). This package shells
 * out to `gh` everywhere and validates against the GitHub CLI's surface, so a
 * neutral event type would be an abstraction over exactly one provider — a
 * second model of something already depended on directly.
 *
 * Nothing here throws. A payload from an event the loop does not run on is the
 * common case, not an error: every `issues.labeled` on every label in the
 * repository reaches this function, and an exception would turn a routine
 * non-event into a red workflow run.
 */

import { ENTRY_LABEL } from '../issue-state/vocabulary'
import { asRecord } from '../json/record'
import { issueNumberFromBranch } from './branch'

/**
 * The phases the loop can start. One ships; `plan` and `review` are designed
 * and unbuilt, and adding one here is the change that makes
 * {@link phaseFromLabels} have to guess less rather than more.
 */
export const PHASES = ['implement'] as const

export type Phase = (typeof PHASES)[number]

/**
 * Which of the two v1 edges (design §3) this is. Carried on the verdict
 * because the two differ in ways a caller acts on: the human edge has a person
 * behind it and starts the loop, the machine edge has nobody on it and
 * continues one.
 */
export type TriggerEdge = 'human' | 'machine'

/**
 * The CI run whose failure retriggered the loop: what to link, and what to ask
 * `gh` for the failing logs of. Both or neither — a run id with no URL would
 * make the handoff's degraded form (URL-only) unrepresentable, and a URL with
 * no id would make the undegraded one unreachable.
 */
export interface CiFailureRef {
  runId: string
  runUrl: string
}

export type TriggerClassification =
  | {
      triggered: true
      phase: Phase
      edge: TriggerEdge
      issueNumber: number
      /** The login whose spend this run would be — what authorization judges. */
      actor: string
      /** `owner/repo`, straight off the payload. */
      repo: string
      /**
       * The failed CI run this event continues — machine edge only, and only
       * when the payload names both halves of it. It is read here rather than
       * re-derived later because this function is the one place the raw payload
       * is parsed, and the handoff artifact (shopfloor#49) needs exactly this:
       * a URL to link and an id to fetch the failing logs by. A human-edge
       * trigger has none, which is a fact about the edge rather than a gap.
       */
      ciFailure?: CiFailureRef
    }
  | {
      triggered: false
      /**
       * Why not, in terms a human reading a skipped job can act on. Never an
       * accusation and never a diagnostic: "this is not an event we run on" is
       * the correct outcome for the large majority of events that reach here.
       */
      reason: string
    }

/**
 * Classify a raw webhook payload.
 *
 * The two admitted edges, and what each is keyed on:
 *
 * - **`issues.labeled` with `ready-for-agent`** — the human edge. Keyed on the
 *   *added* label rather than on the issue's label set, because the harness
 *   adds labels of its own (`agent:in-progress` at the start of a run) and
 *   every one of those fires `issues.labeled` again. A trigger that read the
 *   set instead of the addition would restart itself.
 * - **`workflow_run.completed` with `conclusion: failure` on an
 *   `agent/issue-*` branch** — the machine edge. The branch is the only place
 *   a finished CI run says which issue it belongs to.
 *
 * Design §6's decisive attribution test — was the head commit authored by the
 * agent — is deliberately *not* here. It belongs with the outer loop that acts
 * on this edge (sequencing step 9); what this function commits to is the cheap
 * pre-filter §6 pairs it with, and a caller that admits the machine edge today
 * gets the branch check, not a claim of attribution.
 */
export function classifyTrigger(payload: unknown): TriggerClassification {
  const event = asRecord(payload)

  if (!event) {
    return { triggered: false, reason: 'the payload is not a JSON object' }
  }

  const action = asString(event.action)

  if (action === 'labeled') {
    return classifyLabeled(event)
  }

  if (action === 'completed') {
    return classifyWorkflowRun(event)
  }

  return {
    triggered: false,
    reason: `no admitted trigger has action "${action ?? '(none)'}"`
  }
}

/** The human edge: a person put `ready-for-agent` on an issue. */
function classifyLabeled(event: PayloadRecord): TriggerClassification {
  const addedLabel = asString(asRecord(event.label)?.name)

  if (addedLabel !== ENTRY_LABEL) {
    return {
      triggered: false,
      reason: `the label added was "${addedLabel ?? '(none)'}", not "${ENTRY_LABEL}"`
    }
  }

  const issue = asRecord(event.issue)
  const issueNumber = asIssueNumber(issue?.number)

  if (!issueNumber) {
    return {
      triggered: false,
      reason: 'the payload carries no usable issue number'
    }
  }

  const actor = asString(asRecord(event.sender)?.login)
  const repo = repoFrom(event)

  if (!actor || !repo) {
    return { triggered: false, reason: missingTargetReason(actor) }
  }

  return {
    triggered: true,
    phase: phaseFromLabels(issue?.labels),
    edge: 'human',
    issueNumber,
    actor,
    repo
  }
}

/** The machine edge: CI went red on a branch the loop owns. */
function classifyWorkflowRun(event: PayloadRecord): TriggerClassification {
  const run = asRecord(event.workflow_run)

  if (!run) {
    return {
      triggered: false,
      reason:
        'a completed action carrying no workflow_run is not an admitted trigger'
    }
  }

  const conclusion = asString(run.conclusion)

  if (conclusion !== 'failure') {
    return {
      triggered: false,
      reason: `the workflow run concluded "${conclusion ?? '(none)'}", and only a failure retriggers the loop`
    }
  }

  const branch = asString(run.head_branch) ?? ''
  const issueNumber = issueNumberFromBranch(branch)

  if (!issueNumber) {
    return {
      triggered: false,
      reason: `"${branch}" is not a branch the harness owns, so this failure is somebody else's`
    }
  }

  // The login the failed run itself ran as, not `sender` — on the machine edge
  // `sender` is whoever GitHub attributes the webhook to, while the spend being
  // authorized continues the work of the person whose credentials pushed the
  // branch. `actor` is the fallback for a payload old enough to omit
  // `triggering_actor`.
  const actor =
    asString(asRecord(run.triggering_actor)?.login) ??
    asString(asRecord(run.actor)?.login)
  const repo = repoFrom(event)

  if (!actor || !repo) {
    return { triggered: false, reason: missingTargetReason(actor) }
  }

  // **The branch name is a pre-filter, not the test** (design §6). A fork's
  // branch can be called anything, `agent/issue-46` included, and a
  // `workflow_run` from a fork PR carries the fork's ref with the base
  // repository in `repository`. Without this the prefix alone would let a
  // stranger's branch name address the harness's own edge. Absent rather than
  // mismatched refuses too: this is the guard class that decides on
  // uncertainty, and a head repository nobody stated is not this one.
  const headRepo = asString(asRecord(run.head_repository)?.full_name)

  if (headRepo !== repo) {
    return {
      triggered: false,
      reason:
        `the failure is on ${headRepo ?? 'an unstated repository'}, not on ` +
        `${repo} — a branch named like the harness's is not the harness's`
    }
  }

  // **Commit authorship is the decisive test** (design §6): the branch
  // convention is a name, and a name is something a consumer can change, while
  // the identity on the commit is written by the harness's own run. A human
  // pushing a fix onto the agent's branch is CI red the loop must not answer —
  // they are already at the keyboard.
  const author = commitAuthorOf(run)

  if (!isAgentAuthor(author)) {
    return {
      triggered: false,
      reason:
        `the head commit is authored by ${author ?? 'nobody the payload names'}` +
        `, not by ${AGENT_COMMIT_AUTHOR} — this failure is somebody else's work`
    }
  }

  const classification: TriggerClassification = {
    triggered: true,
    // A finished CI run carries no issue labels, so the phase cannot be read
    // off the payload the way the human edge reads it. One phase ships, so
    // there is nothing to disambiguate; a second one makes this a lookup
    // against the issue, which is a `gh` call and therefore the shell's.
    phase: 'implement',
    edge: 'machine',
    issueNumber,
    actor,
    repo
  }

  const ciFailure = ciFailureOf(run)
  if (ciFailure) classification.ciFailure = ciFailure

  return classification
}

/**
 * Which run failed, for the handoff to link and fetch. Omitted rather than
 * half-filled when the payload names only one of the two: a partial reference
 * would be a fetch against an id nobody can check, or a link the logs cannot be
 * read from.
 */
function ciFailureOf(run: PayloadRecord): CiFailureRef | undefined {
  const runId =
    typeof run.id === 'number' && Number.isSafeInteger(run.id)
      ? String(run.id)
      : asString(run.id)
  const runUrl = asString(run.html_url)

  return runId && runUrl ? { runId, runUrl } : undefined
}

/**
 * The phase from the issue's `agent:<phase>` label, falling back to the only
 * phase that ships. The fallback is what makes an issue labeled
 * `ready-for-agent` and nothing else run rather than refuse — and it is
 * honest exactly while `PHASES` has one member. A second phase turns the
 * fallback into a guess, and the fix at that point is a refusal naming the
 * phase label to add, not a different default.
 */
function phaseFromLabels(labels: unknown): Phase {
  const names = Array.isArray(labels)
    ? labels.map((label) => asString(asRecord(label)?.name))
    : []

  return (
    PHASES.find((phase) => names.includes(PHASE_LABELS[phase])) ?? PHASES[0]
  )
}

/**
 * Which label says a phase owns an issue. Written out rather than built as
 * `agent:${phase}`, because these are names from the package-owned vocabulary
 * (shopfloor#45) and a template quietly invents one for any phase added here —
 * a label nothing creates and nothing verifies. `branch.test.ts`'s sibling
 * check in `classify.test.ts` holds every value in this map to
 * `REQUIRED_LABELS`.
 */
export const PHASE_LABELS: Record<Phase, string> = {
  implement: 'agent:implement'
}

/**
 * A payload that named an event we run on but not who or where. Reported as a
 * non-trigger rather than left to the spend gate, because a missing actor is a
 * malformed payload rather than a person to judge.
 */
function missingTargetReason(actor: string | undefined): string {
  return `the payload names no ${actor ? 'repository' : 'actor'}`
}

function repoFrom(event: PayloadRecord): string | undefined {
  return asString(asRecord(event.repository)?.full_name)
}

/**
 * The identity the agent's own commits carry (design §6). **Fixed, not
 * configurable**, for the reason the label vocabulary is fixed (`CLAUDE.md`):
 * a stated author could only be validated against a git identity this package
 * does not own, and the failure mode is not a broken diagnostic but a silently
 * widened trigger — one consumer naming their own login here turns every
 * commit they push onto an agent branch into a retrigger.
 *
 * Read against the `name` **and** the local part of the `email`, because which
 * of the two carries the bot identity depends on how the run's git was
 * configured, and a payload that names it in only one place is still naming
 * it.
 */
export const AGENT_COMMIT_AUTHOR = 'claude-code[bot]'

/**
 * Who the payload says wrote the head commit, preferring the name and falling
 * back to the email — reported as-is so a refusal can quote it.
 */
function commitAuthorOf(run: PayloadRecord): string | undefined {
  const author = asRecord(asRecord(run.head_commit)?.author)
  return asString(author?.name) ?? asString(author?.email)
}

function isAgentAuthor(author: string | undefined): boolean {
  if (!author) return false
  const normalized = author.trim().toLowerCase()
  return (
    normalized === AGENT_COMMIT_AUTHOR ||
    normalized.startsWith(`${AGENT_COMMIT_AUTHOR}@`)
  )
}

type PayloadRecord = Record<string, unknown>

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

/**
 * GitHub sends issue numbers as JSON numbers, but a hand-built payload — a
 * `workflow_dispatch` shim, a replayed event — may send the string. Both are
 * accepted; anything that is not a positive whole number is not.
 */
function asIssueNumber(value: unknown): number | undefined {
  const parsed = typeof value === 'string' ? Number(value) : value
  return typeof parsed === 'number' &&
    Number.isSafeInteger(parsed) &&
    parsed > 0
    ? parsed
    : undefined
}
