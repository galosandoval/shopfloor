#!/usr/bin/env node
import { probeSetup } from './setup/probe-setup'
import { evaluateSetup, formatSetupReport } from './setup/setup'

/**
 * Bin entrypoint for `shopfloor doctor` — one non-interactive command that
 * says which of a consumer's setup bindings is wrong:
 *
 * ```sh
 * PROMPT_FILE=./agent/implement/prompt.md npx shopfloor-doctor
 * ```
 *
 * Writes nothing, is safe to run in CI, and **exits non-zero on a failing
 * verdict** so a CI step can gate on it. Unknowns — probes that answered
 * nothing — print and do not fail the exit code.
 *
 * Every input resolves inside the harness (`resolveDoctorConfig`), so this
 * entrypoint owns only what it alone can do: print the report and set the
 * exit code.
 */
main()

async function main() {
  const verdict = evaluateSetup(await probeSetup())
  console.log(formatSetupReport(verdict))
  process.exit(verdict.ok ? 0 : 1)
}
