#!/usr/bin/env node
import { reportExhaustion } from './handoff/run-exhaustion'
import { EXHAUSTED_LABEL } from './issue-state/vocabulary'
import type { SpentCeiling } from './trigger/admission'
import { runAdmission } from './trigger/run-admission'

/**
 * Bin entrypoint for admission (shopfloor#46) — the job that runs **before the
 * runner installs anything**, needing only this package and `gh`:
 *
 * ```sh
 * GH_TOKEN=*** npx @galosandoval/shopfloor@<version> shopfloor-admit
 * ```
 *
 * `GITHUB_EVENT_PATH` comes from the runner, so a workflow step states it
 * nowhere. The one flag is
 * `--max-attempts <n>`, because the ceiling's own refusal tells a maintainer
 * to raise it deliberately and a refusal that names no mechanism is not
 * actionable.
 *
 * **The verdict goes to stdout as one line of JSON**, so a job can capture it
 * whole (`>> "$GITHUB_OUTPUT"`, `jq`, whatever the caller's glue prefers) and
 * gate the expensive job on it. The human sentence goes to stderr, which keeps
 * stdout machine-readable without a flag deciding which mode this is in. What
 * to do with either is the caller's: this package owns the verdict, not the CI
 * glue around it.
 *
 * **The exit code splits where `shopfloor-authorize`'s does not, deliberately.**
 * That command is the last word on a spend, so every refusal leaves non-zero.
 * This one is a *gate whose output is read*, and its most common outcome by far
 * is `not-a-trigger` — every label a human adds to any issue in the repository
 * reaches it. Failing those would paint the repository red for events where
 * nothing happened, which is how a check gets deleted. So `not-a-trigger` exits
 * zero; every other refusal — a stranger, an unreadable token, a run already in
 * flight, a spent ceiling — exits non-zero, because those are judgements about
 * a real trigger and a caller who ignores stdout must still be stopped by them.
 *
 * **One refusal writes, and only one** (shopfloor#50). `runAdmission` still
 * writes nothing on any verdict; this bin acts on the `exhausted` one, because
 * the ceiling is the outer loop's **terminal state** and this job is the last
 * place it is observed — the expensive job is gated on the verdict, so nothing
 * downstream exists to land `agent:exhausted` or post the attempt trail. Why
 * that is not the drive-by write the no-write rule protects against is on
 * `reportExhaustion`.
 */
main().catch((error: unknown) => {
  // Admission failing is itself an undetermined verdict, and it is printed in
  // the same shape as a real one so a caller's parser never has two formats.
  console.log(
    JSON.stringify({
      admitted: false,
      refusal: 'undetermined',
      reason: `admission itself failed: ${String(error)}`
    })
  )
  console.error(
    `REFUSED (undetermined): admission itself failed. ${String(error)}`
  )
  process.exit(1)
})

async function main() {
  const verdict = await runAdmission({ maxAttempts: readMaxAttempts() })

  console.log(JSON.stringify(verdict))

  if (verdict.admitted) {
    console.error(
      `ADMITTED: ${verdict.phase} on #${verdict.issueNumber} for @${verdict.actor} ` +
        `(${verdict.edge} edge, attempt ${verdict.attempt}/${verdict.maxAttempts}).`
    )
    return
  }

  console.error(`REFUSED (${verdict.refusal}): ${verdict.reason}`)

  // **The one write this job makes** (shopfloor#50). A spent ceiling is the
  // loop's terminal state, and this job is where it is observed: the expensive
  // job is gated on the verdict above, so nothing downstream ever runs to land
  // `agent:exhausted` or post the trail. Reported after the verdict is printed,
  // so a caller's glue gets its answer whatever the report does, and the
  // report itself is idempotent — the label is what says it already happened.
  if (verdict.refusal === 'exhausted' && verdict.ceiling) {
    await report(verdict.ceiling)
  }

  if (verdict.refusal !== 'not-a-trigger') {
    process.exit(1)
  }
}

/** Land the terminal state, saying what of it reached the issue. */
async function report(ceiling: SpentCeiling): Promise<void> {
  const result = await reportExhaustion({ ceiling })

  console.error(
    result.reported
      ? `Posted ${result.attemptsPosted} of ${result.attemptsRead} attempt ` +
          `handoff(s) on #${ceiling.issueNumber} ` +
          `and ${result.transitioned ? 'labeled it' : 'could not label it'} ` +
          `${EXHAUSTED_LABEL}${result.detail ? ` (${result.detail})` : ''}.`
      : `Left #${ceiling.issueNumber} as it is: ${result.detail ?? 'no reason given'}`
  )
}

/**
 * `--max-attempts <n>`. An unparseable value is a refusal rather than a
 * silent fallback to the default: a ceiling stated wrong is a ceiling the
 * person who stated it believes is in force.
 */
function readMaxAttempts(): number | undefined {
  const flag = process.argv.indexOf('--max-attempts')

  if (flag === -1) {
    return undefined
  }

  const stated = Number(process.argv[flag + 1])

  if (!Number.isSafeInteger(stated) || stated < 1) {
    console.error(
      `--max-attempts needs a whole number of runs, not "${process.argv[flag + 1] ?? ''}"`
    )
    process.exit(1)
    // Unreachable in a real process; stated so a stubbed `exit` cannot let a
    // NaN ceiling through as "no ceiling stated".
    return undefined
  }

  return stated
}
