/**
 * The IO half of `shopfloor init` (shopfloor#43): probe, plan, ask, write.
 * Everything it writes is decided by the pure {@link planInit}; this half owns
 * the reads the plan is made from and the side effects it names.
 *
 * **The one rule this half enforces on its own:** an overwrite is confirmed by
 * a human before it happens, and a run with nobody there to answer declines it
 * rather than assuming yes. Every other write is a creation, which destroys
 * nothing.
 */

import { execFile } from 'node:child_process'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { promisify } from 'node:util'
import {
  formatInitPlan,
  planInit,
  type InitAction,
  type InitPlan
} from './init'
import { probeSetup } from './probe-setup'
import { LOCKFILE_NAMES, type ProjectFacts } from './scaffold'
import { evaluateSetup, type SetupVerdict } from './setup'
import { resolveInitConfig, type DoctorConfig } from './setup-config'

const execFileAsync = promisify(execFile)

export interface RunInitInput extends DoctorConfig {
  /**
   * Asked before every overwrite. Defaults to a terminal question, which
   * answers `false` when nothing is attached to answer it — a scaffolder that
   * assumed yes in CI would be exactly the silent overwrite this command
   * promises not to be.
   */
  confirm?: (question: string) => Promise<boolean>
}

export interface RunInitResult {
  /** What `evaluateSetup` judged before anything was written. */
  verdict: SetupVerdict
  plan: InitPlan
  /** The subset of the plan that was carried out. */
  applied: InitAction[]
  /** Overwrites the operator said no to. Not a failure — a decision. */
  declined: InitAction[]
  /** What went wrong while writing, one line each. Empty on a clean run. */
  errors: string[]
}

export async function runInit(
  input: RunInitInput = {}
): Promise<RunInitResult> {
  const config = resolveInitConfig(input, input.env ?? process.env)
  const cwd = config.cwd ?? process.cwd()

  // The resolved config, not the caller's input: resolution happens once, here,
  // and the doctor is handed stated values it can only pass through. Otherwise
  // `init` and the probe it plans from could resolve the same field twice and
  // disagree — and the prompt path is exactly the field where they would.
  const facts = await probeSetup({ ...config, cwd })
  const verdict = evaluateSetup(facts)
  const plan = planInit({
    facts,
    verdict,
    project: probeProject(cwd),
    promptFile: config.promptFile
  })

  const applied: InitAction[] = []
  const declined: InitAction[] = []
  const errors: string[] = []
  const confirm = input.confirm ?? confirmOnTerminal

  for (const action of plan.actions) {
    if (action.kind === 'write-file' && action.mode === 'overwrite') {
      const yes = await confirm(`Overwrite ${action.file}? ${action.why}`)
      if (!yes) {
        declined.push(action)
        continue
      }
    }

    try {
      await apply(action, { cwd, repo: config.repo })
      applied.push(action)
    } catch (error) {
      errors.push(`${describe(action)}: ${String(error)}`)
    }
  }

  return { verdict, plan, applied, declined, errors }
}

/** Read the two project facts the environment block is filled from. */
function probeProject(cwd: string): ProjectFacts {
  return {
    lockfiles: LOCKFILE_NAMES.filter((lockfile) =>
      fs.existsSync(path.join(cwd, lockfile))
    ),
    packageScripts: readPackageScripts(cwd)
  }
}

/**
 * `scripts` from the project's `package.json`. Null covers unreadable and
 * unparseable alike: both mean the gate is undetermined, and the sentinel says
 * so rather than this guessing which it was.
 */
function readPackageScripts(cwd: string): Record<string, string> | null {
  try {
    const parsed: unknown = JSON.parse(
      fs.readFileSync(path.join(cwd, 'package.json'), 'utf8')
    )
    const scripts =
      parsed && typeof parsed === 'object'
        ? (parsed as { scripts?: unknown }).scripts
        : undefined
    return scripts && typeof scripts === 'object'
      ? (scripts as Record<string, string>)
      : null
  } catch {
    return null
  }
}

async function apply(
  action: InitAction,
  where: { cwd: string; repo?: string }
): Promise<void> {
  if (action.kind === 'create-labels') {
    for (const label of action.labels) {
      // No `--force`: it would rewrite an existing label's colour and
      // description, which is a silent overwrite of something a human owns —
      // the one thing this command promises not to do. A label that appeared
      // between the probe and this write fails loudly instead, and the
      // failure names it.
      await execFileAsync('gh', [
        'label',
        'create',
        label,
        ...(where.repo ? ['--repo', where.repo] : [])
      ])
    }
    return
  }

  const target = path.resolve(where.cwd, action.file)
  fs.mkdirSync(path.dirname(target), { recursive: true })
  fs.writeFileSync(target, action.contents)
}

function describe(action: InitAction): string {
  return action.kind === 'create-labels'
    ? `create labels ${action.labels.join(', ')}`
    : `${action.mode} ${action.file}`
}

/**
 * The default confirmation: one question on the terminal. Anything other than
 * an explicit yes — including a run with no TTY attached — is a no, because
 * the file being asked about is one the operator wrote.
 */
async function confirmOnTerminal(question: string): Promise<boolean> {
  if (!process.stdin.isTTY) {
    console.log(`${question}\n  → declined: nothing attached to confirm it.`)
    return false
  }
  const readline = await import('node:readline/promises')
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
  })
  try {
    const answer = await rl.question(`${question} [y/N] `)
    return /^y(es)?$/i.test(answer.trim())
  } finally {
    rl.close()
  }
}

/**
 * Render what a finished run did, under the plan it was asked to do. Exported
 * beside {@link runInit} so the bin stays as thin as the other three.
 */
export function formatInitResult(result: RunInitResult): string {
  const lines = [formatInitPlan(result.plan)]

  if (result.declined.length > 0) {
    lines.push('', 'Declined, so left as they were:')
    for (const action of result.declined) lines.push(`- ${describe(action)}`)
  }

  if (result.errors.length > 0) {
    lines.push('', 'Failed:')
    for (const error of result.errors) lines.push(`- ${error}`)
  } else if (!result.plan.noop) {
    lines.push(
      '',
      `Done — ${result.applied.length} of ${result.plan.actions.length} applied.`
    )
  }

  return lines.join('\n')
}
