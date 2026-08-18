/**
 * IO shell for admission (shopfloor#46): read the webhook payload, run the
 * probes the pure {@link evaluateAdmission} needs, and return its verdict.
 *
 * **It runs with nothing installed but this package and `gh`** — no consumer
 * dependency install, no database, no browser, no checkout. That is the whole
 * point of it being its own callable (design review finding 2): the guard with
 * the adversarial failure mode must not sit behind the spend it guards. It is
 * shipped as the `shopfloor-admit` bin for the same reason
 * `runAuthorization` is shipped as `shopfloor-authorize`.
 *
 * **It writes nothing**, on any verdict — the same rule the spend gate follows,
 * and for the same reason: a refusal that labelled or commented would hand any
 * drive-by triager a way to make the harness write to the repository. The
 * caller reads the verdict and gates the expensive job on it.
 *
 * Gather → decide → act, with the probes here and every judgement next door.
 */

import { execFile } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { promisify } from 'node:util'
import { runAuthorization } from '../guardrails/run-authorization'
import { describeExecFailure } from '../process/exec-failure'
import {
  evaluateAdmission,
  type AdmissionVerdict,
  type IssueHistoryProbe
} from './admission'
import { classifyTrigger } from './classify'

const execFileAsync = promisify(execFile)

export interface RunAdmissionInput {
  /**
   * The raw webhook payload, already parsed. Omitted means read it from
   * `GITHUB_EVENT_PATH`, which is where the runner puts it.
   */
  payload?: unknown
  /** Defaults to `process.env`. */
  env?: NodeJS.ProcessEnv
  /** Overrides the package's attempt ceiling. */
  maxAttempts?: number
}

/**
 * Classify, authorize, count, and decide.
 *
 * Each probe is skipped once the verdict is settled without it: an event that
 * classifies as nothing never runs the spend gate, and an unauthorized actor
 * never costs a run-list call. The refusals below reach the pure function as
 * absent facts rather than as invented ones — an unread probe and an empty
 * answer stay different things all the way through.
 */
export async function runAdmission(
  input: RunAdmissionInput = {}
): Promise<AdmissionVerdict> {
  const env = input.env ?? process.env
  const payload =
    input.payload === undefined
      ? await readEventPayload(env.GITHUB_EVENT_PATH)
      : { read: true as const, payload: input.payload }

  if ('detail' in payload) {
    return {
      admitted: false,
      refusal: 'undetermined',
      reason:
        `Could not read the webhook payload: ${payload.detail}. Admission ` +
        'cannot classify an event it never saw, and reporting that as "not a ' +
        'trigger" would make a broken wiring look like a quiet one. Pass the ' +
        'payload, or set GITHUB_EVENT_PATH.'
    }
  }

  const classification = classifyTrigger(payload.payload)

  if (!classification.triggered) {
    return evaluateAdmission({ classification, maxAttempts: input.maxAttempts })
  }

  const { verdict: authorization } = await runAuthorization({
    actor: classification.actor,
    repo: classification.repo,
    env
  })

  if (!authorization.authorized) {
    return evaluateAdmission({
      classification,
      authorization,
      maxAttempts: input.maxAttempts
    })
  }

  return evaluateAdmission({
    classification,
    authorization,
    history: await probeIssueHistory(
      classification.repo,
      classification.issueNumber
    ),
    maxAttempts: input.maxAttempts
  })
}

/** `$GITHUB_EVENT_PATH`, parsed. Every way that fails carries its own reason. */
async function readEventPayload(
  path: string | undefined
): Promise<{ read: true; payload: unknown } | { detail: string }> {
  if (!path) {
    return { detail: 'GITHUB_EVENT_PATH is not set' }
  }

  try {
    return { read: true, payload: JSON.parse(await readFile(path, 'utf8')) }
  } catch (error) {
    return { detail: `${path} — ${(error as Error).message}` }
  }
}

/**
 * The issue's label history and its labels now — the two facts the ceiling and
 * the concurrency check are read from.
 *
 * **The timeline, not the labels, is what makes the count possible.** A
 * `labeled` event is permanent: it survives the label being removed by a
 * terminal transition, by an `always()` clear, or by a human. So counting
 * `agent:in-progress` additions counts runs that started, including the ones
 * killed before they could clean up — the failure mode design §4 rejected
 * file-counting for.
 *
 * Two calls rather than one, because GitHub answers the two questions at two
 * endpoints. Both are cheap next to the runner they are deciding whether to
 * pay for, and either failing refuses.
 */
async function probeIssueHistory(
  repo: string,
  issueNumber: number
): Promise<IssueHistoryProbe> {
  try {
    const [additions, current] = await Promise.all([
      gh([
        'api',
        `repos/${repo}/issues/${issueNumber}/timeline`,
        '--paginate',
        '--jq',
        // One name per line, oldest first — a label added, removed, and added
        // again is two lines, which is two attempts.
        '.[] | select(.event == "labeled") | .label.name'
      ]),
      gh([
        'issue',
        'view',
        String(issueNumber),
        '--repo',
        repo,
        '--json',
        'labels',
        '--jq',
        '.labels[].name'
      ])
    ])

    return {
      answered: true,
      labelAdditions: toLines(additions),
      currentLabels: toLines(current)
    }
  } catch (error) {
    return {
      answered: false,
      detail: describeExecFailure(
        error,
        'the issue probe failed — is gh installed?'
      )
    }
  }
}

async function gh(args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('gh', args)
  return stdout
}

/**
 * `--jq` emits one value per line and nothing for an empty result, so an issue
 * with no labels is an empty list rather than a list holding one empty name.
 */
function toLines(stdout: string): string[] {
  return stdout
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
}
