#!/usr/bin/env node
import { runAuthorization } from './guardrails/run-authorization'

/**
 * Bin entrypoint for the spend gate — the one command a setup-free job runs
 * first, before the runner has installed anything:
 *
 * ```sh
 * GH_TOKEN=*** npx @galosandoval/shopfloor@<version> shopfloor-authorize
 * ```
 *
 * `GITHUB_ACTOR` and `GITHUB_REPOSITORY` come from the runner, so a workflow
 * step states neither. Everything else resolves inside the harness, leaving
 * this entrypoint only what it alone can do: print the verdict and **exit
 * non-zero on any refusal**, including one the guard could not determine.
 * Exiting zero on uncertainty is the one behaviour this command must never
 * have.
 */
main().catch((error: unknown) => {
  // The guarantee above is this command's whole contract, so it is stated here
  // rather than left to Node's unhandled-rejection default.
  console.error(
    `REFUSED (undetermined): the spend gate itself failed. ${String(error)}`
  )
  process.exit(1)
})

async function main() {
  const { verdict, actor, repo } = await runAuthorization()

  if (verdict.authorized) {
    console.log(
      `@${actor} may spend on ${repo} ("${verdict.permission}" permission).`
    )
    return
  }

  console.error(`REFUSED (${verdict.refusal}): ${verdict.reason}`)
  process.exit(1)
}
