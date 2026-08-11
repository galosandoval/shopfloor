#!/usr/bin/env node
/**
 * The `PreToolUse` hook script the run's `--settings` payload points at
 * (shopfloor#2): Claude Code pipes the pending tool call in as JSON on stdin,
 * this reads the shell command out of it, and {@link classifyCommand} decides.
 * A block exits 2 with the reason on stderr — the CLI's documented "refuse
 * this tool call and feed stderr back to the agent as the error" channel — and
 * anything else exits 0 and lets the normal permission flow proceed.
 *
 * Exit 2 rather than a `permissionDecision: "deny"` JSON payload on stdout:
 * both deny, but only exit 2 is documented to block regardless of the session's
 * permission flow, and these runs are headless under
 * `--dangerously-skip-permissions` (verified: the hook still fires and the
 * refusal still reaches the agent).
 *
 * All policy lives in `command-policy.ts`; this file is transport only, which
 * is why it has no test of its own. It also never fails the run: anything
 * unreadable, unrecognized, or unexpected exits 0, so the guard is strict about
 * the operations it knows and inert about everything else.
 */

import { classifyCommand } from './command-policy'

interface PreToolUsePayload {
  tool_input?: { command?: unknown }
}

const BLOCK_EXIT_CODE = 2

main()

async function main(): Promise<void> {
  let verdict
  try {
    const command = await readCommand()
    if (!command) return
    verdict = classifyCommand(command)
  } catch (error) {
    // A crash here must not read as a refusal, and must not take the run down
    // with it: report and defer to the normal permission flow.
    console.error(`shopfloor command guard errored, allowing: ${String(error)}`)
    return
  }

  if (verdict.decision !== 'block') return

  console.error(
    `Blocked by the shopfloor command guard [${verdict.rule}]: ` +
      `${verdict.reason} ${verdict.alternative}`
  )
  process.exit(BLOCK_EXIT_CODE)
}

/** The pending call's shell command, or undefined for anything unrecognizable. */
async function readCommand(): Promise<string | undefined> {
  try {
    const chunks: Buffer[] = []
    for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk))
    const payload = JSON.parse(
      Buffer.concat(chunks).toString('utf8')
    ) as PreToolUsePayload
    const command = payload.tool_input?.command
    return typeof command === 'string' ? command : undefined
  } catch {
    return undefined
  }
}
