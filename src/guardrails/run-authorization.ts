import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import {
  evaluateAuthorization,
  isProbeableTarget,
  type AuthorizationVerdict,
  type PermissionProbe
} from './authorization'

const execFileAsync = promisify(execFile)

export interface RunAuthorizationInput {
  /** The login that triggered the run; defaults to `GITHUB_ACTOR`. */
  actor?: string
  /** `owner/repo`; defaults to `GITHUB_REPOSITORY`. */
  repo?: string
  /** Defaults to `process.env`. */
  env?: NodeJS.ProcessEnv
}

export interface RunAuthorizationResult {
  verdict: AuthorizationVerdict
  /** What the probe was run for, resolved — echoed so a caller can log it. */
  actor: string
  repo: string
}

/**
 * The IO half of the spend gate (shopfloor#41): probe the actor's repository
 * permission and hand it to the pure {@link evaluateAuthorization}. It is
 * exported on its own, and shipped as the `shopfloor-authorize` bin, so a
 * setup-free job can run it **before** the runner pays for a checkout, an
 * install, or a database — the guard with the adversarial failure mode must
 * not sit behind the spend it guards.
 *
 * **It writes nothing, on either verdict**, which is the one way it differs
 * from `runPreflight`. Preflight refuses work a maintainer asked for, so
 * labeling and commenting is feedback they want; this refuses a stranger, and
 * a refusal that comments would hand any drive-by triager a way to make the
 * harness write to the repository. The caller acts on the returned verdict —
 * the bin prints it and exits non-zero.
 *
 * The probe fails closed by construction: anything `gh` cannot answer becomes
 * an unread probe, and an unread probe refuses.
 */
export async function runAuthorization(
  input: RunAuthorizationInput = {}
): Promise<RunAuthorizationResult> {
  const env = input.env ?? process.env
  const actor = input.actor ?? env.GITHUB_ACTOR ?? ''
  const repo = input.repo ?? env.GITHUB_REPOSITORY ?? ''

  const verdict = evaluateAuthorization({
    actor,
    repo,
    // An unstated or malformed target is already a refusal, and its probe path
    // is built by interpolation — so it is not spent on a subprocess, and the
    // detail below never reaches a reason because the pure guard refuses on
    // the target before it reads the probe.
    probe: isProbeableTarget(actor, repo)
      ? await probePermission(actor, repo)
      : { read: false, detail: 'not probed' }
  })

  return { verdict, actor, repo }
}

/**
 * `gh api repos/{repo}/collaborators/{actor}/permission`. Every failure —
 * `gh` missing, unauthenticated, rate-limited, a 404 on a login that does not
 * exist — becomes an unread probe carrying what `gh` said, rather than a
 * throw: the guard's whole point is that it decides on uncertainty instead of
 * crashing on it.
 */
async function probePermission(
  actor: string,
  repo: string
): Promise<PermissionProbe> {
  try {
    const { stdout } = await execFileAsync('gh', [
      'api',
      `repos/${repo}/collaborators/${actor}/permission`,
      '--jq',
      '.permission'
    ])
    return { read: true, permission: stdout }
  } catch (error) {
    return { read: false, detail: describeProbeFailure(error) }
  }
}

/** `gh`'s own first line of complaint, which is the line worth reporting. */
function describeProbeFailure(error: unknown): string {
  const stderr =
    typeof error === 'object' && error !== null && 'stderr' in error
      ? String((error as { stderr: unknown }).stderr)
      : ''
  const message = stderr.trim() || String(error)
  return message.split('\n')[0]?.trim() || 'the permission probe failed'
}
