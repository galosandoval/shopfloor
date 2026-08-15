#!/usr/bin/env node
import { formatInitResult, runInit } from './setup/run-init'

/**
 * Bin entrypoint for `shopfloor init` — `doctor` plus writers, run at a moment
 * a human asked for it:
 *
 * ```sh
 * npx shopfloor-init
 * ```
 *
 * It creates the label vocabulary, scaffolds the workflow and the prompt, and
 * fills the prompt's environment block from this project's lockfile and
 * scripts. It is re-runnable — a second run on a configured repository writes
 * nothing — and it **never overwrites without being asked**, which includes
 * declining every overwrite when there is no terminal to ask.
 *
 * Every input resolves inside the harness (`resolveInitConfig`), so this
 * entrypoint owns only what it alone can do: print the report and set the exit
 * code. Non-zero on a write that failed — not on the setup this command cannot
 * fix for you, which it names and leaves to you.
 */
main()

async function main() {
  const result = await runInit()
  console.log(formatInitResult(result))
  process.exit(result.errors.length > 0 ? 1 : 0)
}
