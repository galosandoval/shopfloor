/**
 * The IO half of `shopfloor doctor` (shopfloor#39): every `gh`, `claude`, and
 * filesystem read the verdict needs, gathered into {@link SetupFacts} and
 * handed to the pure {@link evaluateSetup}. Gather → decide → act, with all of
 * the gathering on this side of the seam.
 *
 * **Read-only, and it never throws.** Doctor is safe to run in CI and
 * idempotent because it writes nothing at all — no labels created, no secrets
 * set, no files touched. A probe that fails becomes `'unknown'` in the facts,
 * which the pure half reports and does not fail on: a doctor that cannot read
 * `gh` must not be indistinguishable from a repository that is misconfigured.
 */

import { execFile } from 'node:child_process'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { promisify } from 'node:util'
import { parseGhTokenScopes } from './parse-facts'
import { type SetupFacts } from './setup'
import { resolveDoctorConfig, type DoctorConfig } from './setup-config'

const execFileAsync = promisify(execFile)

/** Where GitHub Actions requires workflows to live. */
const WORKFLOWS_DIR = '.github/workflows'

/** Gather everything {@link evaluateSetup} judges. */
export async function probeSetup(
  input: DoctorConfig = {}
): Promise<SetupFacts> {
  const config = resolveDoctorConfig(input, input.env ?? process.env)
  const cwd = config.cwd ?? process.cwd()

  const authOutput = await probe(['auth', 'status'])
  const repo = config.repo ?? (await probeRepo())

  const [secrets, labels, defaultBranch, cliVersion] = await Promise.all([
    probeSecrets(repo),
    probeJson<Array<{ name: string }>>([
      'label',
      'list',
      ...repoFlag(repo),
      '--limit',
      '200',
      '--json',
      'name'
    ]),
    probeDefaultBranch(repo),
    probeCliVersion()
  ])

  const facts: SetupFacts = {
    requiredSecrets: config.requiredSecrets,
    patSecret: config.patSecret,
    ghAuth:
      authOutput === null
        ? 'unknown'
        : authOutput.ok
          ? 'authenticated'
          : 'unauthenticated',
    ghTokenScopes:
      authOutput === null ? 'unknown' : parseGhTokenScopes(authOutput.output),
    repoSecrets: secrets,
    repoLabels: labels === null ? 'unknown' : labels.map((l) => l.name),
    promptTemplate: config.promptFile
      ? readFile(path.resolve(cwd, config.promptFile))
      : null,
    workflow: readFile(path.resolve(cwd, config.workflowFile)),
    workflowFile: config.workflowFile,
    defaultBranchWorkflowFiles: await probeDefaultBranchWorkflows(
      repo,
      defaultBranch
    )
  }

  if (cliVersion) facts.runningCliVersion = cliVersion
  if (config.cliVersion) facts.pinnedCliVersion = config.cliVersion

  return facts
}

/**
 * Every secret name a workflow in this repository can reach: the repository's
 * own, plus the organization secrets shared with it. The second call is why
 * this is not one line — a consumer whose token lives in an org secret is
 * correctly configured, and checking only `gh secret list` would fail them.
 *
 * Environment-scoped secrets are still invisible here, and are the reason
 * `REQUIRED_SECRETS` can be stated as empty.
 */
async function probeSecrets(
  repo: string | undefined
): Promise<string[] | 'unknown'> {
  const own = await probeJson<Array<{ name: string }>>([
    'secret',
    'list',
    ...repoFlag(repo),
    '--json',
    'name'
  ])
  if (own === null) return 'unknown'

  const shared = repo
    ? await probeJson<{ secrets: Array<{ name: string }> }>([
        'api',
        `repos/${repo}/actions/organization-secrets`
      ])
    : null
  return [
    ...own.map((secret) => secret.name),
    ...(shared?.secrets ?? []).map((secret) => secret.name)
  ]
}

/** `owner/repo` for the checkout, or undefined — `gh` then infers it per call. */
async function probeRepo(): Promise<string | undefined> {
  const repo = await probeJson<{ nameWithOwner: string }>([
    'repo',
    'view',
    '--json',
    'nameWithOwner'
  ])
  return repo?.nameWithOwner
}

async function probeDefaultBranch(
  repo: string | undefined
): Promise<string | undefined> {
  const view = await probeJson<{ defaultBranchRef: { name: string } | null }>([
    'repo',
    'view',
    ...repoFlag(repo),
    '--json',
    'defaultBranchRef'
  ])
  return view?.defaultBranchRef?.name
}

/**
 * Workflow file names present on the default branch, read from the API rather
 * than from disk: the checkout doctor runs in is usually not the default
 * branch, and a `workflow_run` trigger fires from nowhere else — so the local
 * copy answers a different question than the one being asked.
 */
async function probeDefaultBranchWorkflows(
  repo: string | undefined,
  defaultBranch: string | undefined
): Promise<string[] | 'unknown'> {
  if (!repo || !defaultBranch) return 'unknown'
  const contents = await probeJson<Array<{ name: string }>>([
    'api',
    `repos/${repo}/contents/${WORKFLOWS_DIR}?ref=${defaultBranch}`
  ])
  return contents === null ? 'unknown' : contents.map((entry) => entry.name)
}

async function probeCliVersion(): Promise<string | undefined> {
  try {
    const { stdout } = await execFileAsync('claude', ['--version'])
    return stdout.trim() || undefined
  } catch {
    return undefined
  }
}

/** `--repo owner/repo` when it is known; `gh` infers it from the checkout otherwise. */
function repoFlag(repo: string | undefined): string[] {
  return repo ? ['--repo', repo] : []
}

/**
 * Run `gh`, keeping a non-zero exit as an answer rather than an error — `gh
 * auth status` reports "not logged in" that way, and that is a fact about the
 * setup, not a failed probe. Null means `gh` could not be run at all.
 */
async function probe(
  args: string[]
): Promise<{ ok: boolean; output: string } | null> {
  try {
    const { stdout, stderr } = await execFileAsync('gh', args)
    return { ok: true, output: `${stdout}\n${stderr}` }
  } catch (error) {
    const failure = error as {
      code?: unknown
      stdout?: string
      stderr?: string
    }
    // A spawn failure carries no exit code — that is "gh is not installed",
    // which is unknown rather than unauthenticated.
    if (typeof failure.code !== 'number') return null
    return {
      ok: false,
      output: `${failure.stdout ?? ''}\n${failure.stderr ?? ''}`
    }
  }
}

/** Run `gh` and parse stdout as JSON; null when the call or the parse failed. */
async function probeJson<T>(args: string[]): Promise<T | null> {
  try {
    const { stdout } = await execFileAsync('gh', args)
    return JSON.parse(stdout) as T
  } catch {
    return null
  }
}

/** File contents, or null when there is nothing readable there. */
function readFile(file: string): string | null {
  try {
    return fs.readFileSync(file, 'utf8')
  } catch {
    return null
  }
}
