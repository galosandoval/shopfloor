#!/usr/bin/env node
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import {
  runImplementAgent,
  ImplementAgentError,
  type RunImplementAgentConfig
} from './orchestration/implement'

/**
 * Env-var-driven CLI entrypoint for {@link runImplementAgent}, for drop-in use
 * as a single CI step (mirrors recipe-chat-v1's original
 * `bun agent/implement/implement.ts` invocation style). Consumers who want a
 * typed config object instead should import `runImplementAgent` directly.
 */

const ISSUE_NUMBER = required('ISSUE_NUMBER')
const ISSUE_TITLE = required('ISSUE_TITLE')
const BRANCH = required('BRANCH')
const CLAUDE_CODE_OAUTH_TOKEN = required('CLAUDE_CODE_OAUTH_TOKEN')
/** Path to the caller's own prompt template file — this package ships none. */
const PROMPT_FILE = required('PROMPT_FILE')

const STANDARDS_DIR = process.env.STANDARDS_DIR ?? ''
const OUTPUT_DIR = process.env.OUTPUT_DIR ?? os.tmpdir()
const SCREENSHOTS_DIR =
  process.env.SCREENSHOTS_DIR ?? `.agent/verify/issue-${ISSUE_NUMBER}`
const PROJECTS_DIR =
  process.env.PROJECTS_DIR ?? path.join(os.homedir(), '.claude', 'projects')

const config: RunImplementAgentConfig = {
  issueNumber: ISSUE_NUMBER,
  issueTitle: ISSUE_TITLE,
  branch: BRANCH,
  claudeCodeOAuthToken: CLAUDE_CODE_OAUTH_TOKEN,
  standardsDir: STANDARDS_DIR,
  promptTemplate: fs.readFileSync(PROMPT_FILE, 'utf8'),
  prDescriptionFile: path.join(OUTPUT_DIR, 'pr_description.txt'),
  verifyReportFile: path.join(OUTPUT_DIR, 'verify_report.md'),
  screenshotsDir: SCREENSHOTS_DIR,
  transcriptFile: path.join(OUTPUT_DIR, 'transcript.jsonl'),
  projectsDir: PROJECTS_DIR,
  runPolicy: {
    model: required('MODEL'),
    maxTurns: Number(required('MAX_TURNS')),
    cliVersion: required('CLI_VERSION'),
    idleMinutes: Number(required('IDLE_MINUTES')),
    wallClockMinutes: Number(required('WALL_CLOCK_MINUTES')),
    // The caller's own app-specific env vars (DB URLs, API keys, ...) — this
    // package bakes in no such names of its own.
    requiredEnvVars: required('REQUIRED_ENV_VARS')
      .split(',')
      .map((name) => name.trim())
      .filter(Boolean)
  }
}

main()

async function main() {
  try {
    const result = await runImplementAgent(config)
    console.log(`\n${result.commitsAhead} commit(s) on ${BRANCH} this run.`)
  } catch (error) {
    const message =
      error instanceof ImplementAgentError
        ? `${error.message}${error.outputTail ? `\n\n${error.outputTail}` : ''}`
        : String(error)
    console.error(`\nFAILED: ${message}`)
    fs.writeFileSync(path.join(OUTPUT_DIR, 'failure_reason.txt'), message)
    process.exit(1)
  }
}

function required(name: string): string {
  const value = process.env[name]
  if (!value) {
    console.error(`Missing required env var: ${name}`)
    process.exit(1)
  }
  return value
}
