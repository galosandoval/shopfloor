/**
 * Pure authorization: may this actor spend the maintainer's subscription on
 * this repository? (shopfloor#41.) No IO here —
 * {@link runAuthorization} probes the actor's repository permission via `gh`
 * and acts on the verdict.
 *
 * **This is the one guard in the package that refuses on uncertainty**, and it
 * inverts the rule the others follow (`CONTEXT.md`, "Guardrails fail in the
 * direction that costs least"). Everywhere else an unreadable signal proceeds,
 * because a missing diagnostic must not cause an outage. Here an unreadable
 * signal means "I do not know whether this person may spend your money," and
 * proceeding is the expensive direction — this is the only guardrail whose
 * failure mode is financial and adversarial rather than operational. So an
 * unreadable, empty, or unrecognized probe result refuses, and the refusal
 * distinguishes *not permitted* from *could not determine*: they are a
 * trespasser and a broken token, and collapsing them would hide an outage
 * inside a security message.
 */

/**
 * What the probe of `repos/{repo}/collaborators/{actor}/permission` came back
 * with. Answered-but-unrecognized is deliberately not a third case: it arrives
 * as a `permission` this module does not know, and is judged here rather than
 * by the shell.
 *
 * The discriminant is `answered`, not `read`, because `read` is also one of
 * the permission levels being judged — `{ read: true, permission: 'read' }`
 * reads as a contradiction and is not one.
 */
export type PermissionProbe =
  | { answered: true; permission: string }
  | { answered: false; detail: string }

export interface AuthorizationInput {
  /** The GitHub login that triggered the run (`github.actor`). */
  actor: string
  /** `owner/repo`, e.g. `galosandoval/recipe-chat`. */
  repo: string
  /**
   * Omitted when the caller never ran the probe — for an unstated or malformed
   * target, the shell decides not to spend a subprocess on it. An absent probe
   * is uncertainty like any other and refuses on its own terms, so the two
   * halves are not coupled by the order this function checks things in.
   */
  probe?: PermissionProbe
}

export type AuthorizationVerdict =
  | { authorized: true; permission: SpendingPermission }
  | {
      authorized: false
      /**
       * `not-permitted` — the probe answered, and the answer was no.
       * `undetermined` — the probe answered nothing usable, and this guard
       * refuses rather than assume.
       */
      refusal: 'not-permitted' | 'undetermined'
      reason: string
    }

/**
 * The levels that may spend: everything with push access. A `triage`
 * collaborator can label an issue and therefore trigger the loop, which is
 * exactly the actor this guard exists to stop — labeling is not spending.
 *
 * **Fixed, not configurable**, for the reason the label vocabulary is fixed
 * (`CLAUDE.md`): a stated set could only be validated against a role model
 * this package does not own, and the failure mode is not a broken diagnostic
 * but a silently reopened spend gate — one consumer writing `['read']` undoes
 * the guard with no error anywhere. Exported so a caller who probes the
 * permission another way can state the same rule rather than restate it.
 */
export const SPENDING_PERMISSIONS = ['admin', 'maintain', 'write'] as const

/** A level that may spend. The authorized verdict carries which one it was. */
export type SpendingPermission = (typeof SPENDING_PERMISSIONS)[number]

/**
 * Every value GitHub's permission API is known to return — the five role names
 * it reports in `role_name`. A permission outside this set is not a refusal —
 * it is uncertainty, and uncertainty refuses with the reason that says so. An
 * organization's **custom repository role** lands there by design: a name this
 * guard has never seen is not evidence that its holder may spend.
 */
const KNOWN_PERMISSIONS = [
  ...SPENDING_PERMISSIONS,
  'triage',
  'read',
  'none'
] as const

type KnownPermission = (typeof KNOWN_PERMISSIONS)[number]

function isSpendingPermission(value: string): value is SpendingPermission {
  return (SPENDING_PERMISSIONS as readonly string[]).includes(value)
}

function isKnownPermission(value: string): value is KnownPermission {
  return (KNOWN_PERMISSIONS as readonly string[]).includes(value)
}

/** A GitHub login: alphanumerics and inner hyphens, nothing else. */
const LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/

/**
 * `owner/repo`, each half a name GitHub would accept. The repository half
 * admits leading dots (`.github` is a real repository) but never *only* dots,
 * which is the shape that walks the probe path.
 */
const REPO = /^[A-Za-z0-9-]+\/(?!\.+$)[A-Za-z0-9._-]+$/

/**
 * Whether these are shapes worth probing at all. Exported for
 * {@link runAuthorization}, which skips the subprocess when this is false —
 * the verdict is already decided, and the probe path is built by
 * interpolation, so an actor carrying a `/` or a `..` would silently address a
 * different endpoint than the one whose answer is being trusted.
 */
export function isProbeableTarget(actor: string, repo: string): boolean {
  return LOGIN.test(actor.trim()) && REPO.test(repo.trim())
}

/** Decide whether `actor` may start a run that spends on `repo`. */
export function evaluateAuthorization(
  input: AuthorizationInput
): AuthorizationVerdict {
  const actor = input.actor.trim()
  const repo = input.repo.trim()

  if (!actor || !repo) {
    return undetermined(
      actor || '(unnamed actor)',
      repo || '(unnamed repository)',
      `the ${actor ? 'repository' : 'actor'} was not stated`
    )
  }

  if (!isProbeableTarget(actor, repo)) {
    return undetermined(
      actor,
      repo,
      LOGIN.test(actor)
        ? `"${repo}" is not an owner/repo`
        : `"${actor}" is not a GitHub login`
    )
  }

  if (!input.probe) {
    return undetermined(actor, repo, 'the permission was never probed')
  }

  if (!input.probe.answered) {
    return undetermined(actor, repo, input.probe.detail)
  }

  const permission = input.probe.permission.trim().toLowerCase()

  if (!permission) {
    return undetermined(actor, repo, 'the permission probe returned nothing')
  }

  if (isSpendingPermission(permission)) {
    return { authorized: true, permission }
  }

  if (!isKnownPermission(permission)) {
    return undetermined(
      actor,
      repo,
      `the permission probe returned "${permission}", which is not a permission level this guard recognizes`
    )
  }

  return {
    authorized: false,
    refusal: 'not-permitted',
    reason:
      `@${actor} has "${permission}" permission on ${repo}, and this run ` +
      `spends the maintainer's Claude subscription. It requires one of: ` +
      `${SPENDING_PERMISSIONS.join(', ')}. Ask a maintainer to grant ` +
      `@${actor} write access, or to trigger the run themselves.`
  }
}

/**
 * The refusal that is not an accusation. It names the probe failure verbatim,
 * because the person reading it is usually a maintainer whose token stopped
 * working rather than the actor being judged.
 */
function undetermined(
  actor: string,
  repo: string,
  detail: string
): AuthorizationVerdict {
  return {
    authorized: false,
    refusal: 'undetermined',
    reason:
      `Could not determine whether @${actor} may spend on ${repo}: ` +
      `${detail}. This guard refuses on uncertainty — an unreadable ` +
      'permission is not permission. Give the probe a token that can read ' +
      `${repo}'s collaborator permissions and retrigger.`
  }
}
