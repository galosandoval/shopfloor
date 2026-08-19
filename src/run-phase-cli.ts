#!/usr/bin/env node
import * as fs from 'node:fs'
import * as path from 'node:path'
import { runPhase } from './phase/run-phase'
import { ImplementAgentError } from './orchestration/implement-error'
import { FAILURE_REASON_FILE, resolveOutputDir } from './orchestration/config'

/**
 * Bin entrypoint for the one verb (shopfloor#47), for use as a single CI step:
 *
 * ```sh
 * CLAUDE_CODE_OAUTH_TOKEN=*** GH_TOKEN=*** npx shopfloor-run-phase
 * ```
 *
 * It takes no issue number and no branch: the webhook payload at
 * `GITHUB_EVENT_PATH` says which phase, which issue, and on whose behalf, and
 * the branch is the harness's own. That is the whole of what replaced the
 * consumer's slug pipeline — a step that states nothing cannot state it wrong.
 *
 * `PROMPT_FILE` is still read, and applies to whichever phase the payload
 * discovered; unset, the run spawns on the shim this package ships. Everything
 * else resolves inside the harness, so this entrypoint owns only what it alone
 * can do: turn a verdict into an exit code and write a failure reason for the
 * CI job to surface.
 *
 * **The exit code splits the way `shopfloor-admit`'s does**, and for the same
 * reason: `not-a-trigger` is the outcome for the large majority of events that
 * reach the loop, and painting the repository red for those is how a check
 * gets deleted. Every other refusal, and every failed run, exits non-zero.
 */

main()

async function main() {
  try {
    const result = await runPhase()

    if (!result.ran) {
      console.error(`REFUSED (${result.refusal}): ${result.reason}`)
      if (result.refusal !== 'not-a-trigger') process.exit(1)
      return
    }

    console.log(
      `\n${result.phase} on #${result.issueNumber}: ${result.run.commitsAhead} ` +
        `commit(s) on ${result.branch}, PR ${result.pullRequest.url} ` +
        `(${result.pullRequest.created ? 'opened' : 'reused'}).`
    )
  } catch (error) {
    const message =
      error instanceof ImplementAgentError
        ? `${error.message}${error.outputTail ? `\n\n${error.outputTail}` : ''}`
        : String(error)
    console.error(`\nFAILED: ${message}`)
    writeFailureReason(message)
    process.exit(1)
  }
}

/**
 * Writes the failure where the run's outputs go, so a CI job can surface it as
 * an artifact. Derived from `outputDir` alone rather than from a fully
 * resolved config: the failures worth reporting most — a missing token, an
 * unreadable payload — are exactly the ones where resolution itself throws.
 */
function writeFailureReason(message: string): void {
  try {
    const outputDir = resolveOutputDir({}, process.env)
    fs.writeFileSync(path.join(outputDir, FAILURE_REASON_FILE), message)
  } catch {
    // An unwritable output dir is not worth a second failure — the message is
    // already on stderr.
  }
}
