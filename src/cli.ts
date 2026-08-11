#!/usr/bin/env node
import * as fs from 'node:fs'
import { runImplementAgent } from './orchestration/implement'
import { ImplementAgentError } from './orchestration/implement-error'
import * as path from 'node:path'
import {
  FAILURE_REASON_FILE,
  resolveOutputDir,
  type RunImplementAgentConfig
} from './orchestration/config'

/**
 * Env-var-driven CLI entrypoint for {@link runImplementAgent}, for drop-in use
 * as a single CI step:
 *
 * ```sh
 * CLAUDE_CODE_OAUTH_TOKEN=*** PROMPT_FILE=./prompt.md npx shopfloor-implement 123
 * ```
 *
 * Every other input resolves inside the harness, so this entrypoint owns only
 * what it alone can do: read the issue number off `argv`, read the prompt
 * template off disk, and write a failure reason for the CI job to surface.
 * Consumers who want a typed config object instead should import
 * `runImplementAgent` directly.
 */

const input: RunImplementAgentConfig = {
  issueNumber: process.argv[2] ?? process.env.ISSUE_NUMBER,
  /** The caller's own prompt template — this package ships none. */
  promptTemplate: readPromptTemplate()
}

main()

async function main() {
  try {
    const result = await runImplementAgent(input)
    console.log(
      `\n${result.commitsAhead} commit(s) on ${result.branch} this run.`
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

/** Reads `PROMPT_FILE`, failing with a named message rather than a stack trace. */
function readPromptTemplate(): string {
  const file = process.env.PROMPT_FILE
  if (!file) {
    console.error('Missing required env var: PROMPT_FILE')
    process.exit(1)
  }
  try {
    return fs.readFileSync(file, 'utf8')
  } catch {
    console.error(`Could not read PROMPT_FILE: ${file}`)
    process.exit(1)
  }
}

/**
 * Writes the failure where the run's outputs go, so a CI job can surface it as
 * an artifact. Derived from `outputDir` alone rather than from a fully
 * resolved config: the failures worth reporting most — a missing token, an
 * unresolvable issue — are exactly the ones where resolution itself throws.
 */
function writeFailureReason(message: string): void {
  try {
    const outputDir = resolveOutputDir(input, process.env)
    fs.writeFileSync(path.join(outputDir, FAILURE_REASON_FILE), message)
  } catch {
    // An unwritable output dir is not worth a second failure — the message is
    // already on stderr.
  }
}
