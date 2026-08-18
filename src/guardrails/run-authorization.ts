import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { describeExecFailure } from '../process/exec-failure'
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
    // is built by interpolation — so no subprocess is spent on it, and no
    // probe result is invented to stand in for the one never taken.
    probe: isProbeableTarget(actor, repo)
      ? await probePermission(actor, repo)
      : undefined
  })

  return { verdict, actor, repo }
}

/**
 * `gh api repos/{repo}/collaborators/{actor}/permission`. Every failure —
 * `gh` missing, unauthenticated, rate-limited, a 404 on a login that does not
 * exist — becomes an unanswered probe carrying what `gh` said, rather than a
 * throw: the guard's whole point is that it decides on uncertainty instead of
 * crashing on it.
 *
 * **`role_name`, not `permission`.** The endpoint's legacy `permission` field
 * only ever reports `admin` | `write` | `read` | `none`, so a `maintain`
 * collaborator arrives as `write` and a `triage` one as `read` — the verdicts
 * happen to land right, but two of the levels the guard judges could never
 * reach it, and the set it documents would be fiction. `role_name` reports all
 * five. The `//` falls back for an API old enough not to send it (GHES),
 * rather than turning a missing field into `null` and refusing a maintainer.
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
      '.role_name // .permission'
    ])
    return { answered: true, permission: stdout }
  } catch (error) {
    return {
      answered: false,
      detail: describeExecFailure(error, 'the permission probe failed')
    }
  }
}
