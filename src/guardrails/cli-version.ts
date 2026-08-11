/**
 * Pure comparison of the running Claude Code CLI against the version a run
 * policy was validated against (shopfloor#5). No IO here — the orchestrator
 * runs `claude --version` and hands the raw output in, matching the
 * `preflight.ts` / `run-preflight.ts` pure-core-plus-IO-shell split the
 * package already uses.
 *
 * The harness reads CLI surface that can move underneath it: the headless flag
 * vector, the stream-json event shape, and the `~/.claude/projects` session
 * layout. When one of those moves, the run degrades into a confusing
 * downstream symptom — an empty transcript, an unparseable stream, a flag
 * error buried in the output tail — rather than into "your pin doesn't match".
 * That is what this exists to name.
 */

/** How loudly a version mismatch is reported; see {@link checkCliVersion}. */
export type CliVersionStrictness = 'warn' | 'error' | 'off'

/**
 * Warn, never block. An exact pin would mean every upstream Claude Code
 * release breaks every consumer until they bump a constant, which trains
 * people to delete the check. Consumers needing reproducibility opt into
 * `'error'`; `'off'` exists for local dev.
 */
export const DEFAULT_CLI_VERSION_STRICTNESS: CliVersionStrictness = 'warn'

export interface CliVersionCheckInput {
  /** Raw `claude --version` output, or undefined when the probe answered nothing. */
  running?: string
  /** The run policy's `cliVersion`; undefined means record-only, no comparison. */
  pinned?: string
  strictness: CliVersionStrictness
}

/**
 * `'unchecked'` covers every case where no comparison happened at all —
 * strictness `'off'`, no pin, or a version string on either side that this
 * module could not read. It carries a message in the one case a human should
 * hear about: a pin that was stated but could not be read, which would
 * otherwise disable the check silently. Only a mismatch can block, and only
 * ever under `'error'` strictness.
 */
export type CliVersionVerdict =
  | { status: 'match' | 'unchecked'; message?: string; blocking: false }
  | { status: 'mismatch'; message: string; blocking: boolean }

/** Leading semver, ignoring a `v` prefix and any suffix like ` (Claude Code)`. */
const LEADING_SEMVER = /^\s*v?(\d+)\.(\d+)\.(\d+)/

/**
 * The semver at the head of `raw`, or undefined when there isn't one. Tolerant
 * by design: the observed output is `2.1.220 (Claude Code)`, and anything this
 * cannot read is treated as "unknown version" rather than as a failure, so a
 * missing or reworded `claude --version` never costs a run.
 */
export function parseCliVersion(raw: string | undefined): string | undefined {
  const match = raw?.match(LEADING_SEMVER)
  return match ? `${match[1]}.${match[2]}.${match[3]}` : undefined
}

/** A strictness level read from configuration, or undefined when unrecognized. */
export function parseCliVersionStrictness(
  raw: string | undefined
): CliVersionStrictness | undefined {
  const level = raw?.trim().toLowerCase()
  return level === 'warn' || level === 'error' || level === 'off'
    ? level
    : undefined
}

/**
 * Compare a running CLI against the pin.
 *
 * **Strict mode means same `major.minor`, not exact match.** The surfaces this
 * harness depends on are CLI features, and features arrive in minor releases;
 * a patch bump is a fix to surface that already exists. Requiring the patch to
 * match would fail runs over changes that cannot affect the harness, which is
 * the pin-churn that makes people delete the check. The same rule decides a
 * warn — only the consequence differs between strictness levels.
 *
 * Never blocking unless both versions parse *and* strictness is `'error'`: an
 * unreadable version is the harness's own uncertainty, and refusing a run over
 * it would turn a missing diagnostic into an outage.
 */
export function checkCliVersion(input: CliVersionCheckInput): CliVersionVerdict {
  const unchecked: CliVersionVerdict = { status: 'unchecked', blocking: false }
  if (input.strictness === 'off') return unchecked

  const running = parseCliVersion(input.running)
  const pinned = parseCliVersion(input.pinned)
  if (input.pinned && !pinned) {
    // Stated but unreadable: still not worth refusing a run over, but saying
    // nothing would leave a consumer believing a check that isn't running.
    return {
      ...unchecked,
      message:
        `Pinned Claude Code CLI version "${input.pinned}" is not a version ` +
        'this harness can read, so the running CLI was not checked against ' +
        'it. Expected a semver like 2.1.220.'
    }
  }
  if (!running || !pinned) return unchecked

  if (sameMajorMinor(running, pinned)) return { status: 'match', blocking: false }

  return {
    status: 'mismatch',
    message:
      `Claude Code CLI version ${running} does not match the pinned ` +
      `${pinned} this run policy was validated against — this harness reads ` +
      'CLI surface that moves between minor releases.',
    blocking: input.strictness === 'error'
  }
}

function sameMajorMinor(a: string, b: string): boolean {
  const [aMajor, aMinor] = a.split('.')
  const [bMajor, bMinor] = b.split('.')
  return aMajor === bMajor && aMinor === bMinor
}
