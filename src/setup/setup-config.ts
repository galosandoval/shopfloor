/**
 * The configuration contract for `shopfloor doctor` (shopfloor#39), and the
 * pure function that resolves it. Same order as every other resolution in this
 * package — explicit input, then environment variable, then package default —
 * and the same reason it is pure: the environment arrives as a parameter, so
 * what the doctor decided to look at is testable without touching disk.
 *
 * The bin entrypoint states nothing; resolution lives here so the CLI stays as
 * thin as `cli.ts` is.
 */

/** Everything a caller may state about a doctor run. */
export interface DoctorConfig {
  /** `owner/repo` — defaults to `GITHUB_REPOSITORY`, else probed from the checkout. */
  repo?: string
  /** Path to the prompt template to check; defaults to `PROMPT_FILE`. Unstated, the prompt checks report unknown. */
  promptFile?: string
  /** Path to the agent workflow; defaults to `WORKFLOW_FILE`, then {@link DEFAULT_WORKFLOW_FILE}. */
  workflowFile?: string
  /** Secrets the setup requires; defaults to `REQUIRED_SECRETS` (comma-separated), then the two below. */
  requiredSecrets?: string[]
  /** Which secret holds the PAT; defaults to `AGENT_PAT_SECRET`, then {@link DEFAULT_PAT_SECRET}. */
  patSecret?: string
  /** The CLI pin to compare the running `claude --version` against; defaults to `CLI_VERSION`. */
  cliVersion?: string
  /** Defaults to `process.cwd()`, resolved by the probe rather than here. */
  cwd?: string
  /** Defaults to `process.env`. */
  env?: NodeJS.ProcessEnv
}

export interface ResolvedDoctorConfig {
  repo?: string
  promptFile?: string
  workflowFile: string
  requiredSecrets: string[]
  patSecret: string
  cliVersion?: string
  cwd?: string
}

/**
 * Where the live consumer's agent workflow sits. A default rather than a
 * requirement: a consumer whose workflow is named otherwise states
 * `WORKFLOW_FILE`, and one who does neither gets an `unknown` naming the
 * variable rather than a failure about a file they never claimed to have.
 */
export const DEFAULT_WORKFLOW_FILE = '.github/workflows/agent-implement.yml'

/**
 * The PAT secret's default name. It is named at all — rather than being any
 * token that happens to work — because the machine edge depends on the push
 * being made with it: a push made with the built-in `GITHUB_TOKEN` fires no
 * downstream events, so the loop would run exactly once.
 */
export const DEFAULT_PAT_SECRET = 'AGENT_PAT'

/** The Anthropic half of the pair: the subscription token a run spawns under. */
export const OAUTH_TOKEN_SECRET = 'CLAUDE_CODE_OAUTH_TOKEN'

/** Resolve a caller's partial doctor config against `env`. Total — nothing here can fail. */
export function resolveDoctorConfig(
  input: DoctorConfig,
  env: Record<string, string | undefined>
): ResolvedDoctorConfig {
  const patSecret =
    input.patSecret ?? env.AGENT_PAT_SECRET ?? DEFAULT_PAT_SECRET

  const resolved: ResolvedDoctorConfig = {
    workflowFile:
      input.workflowFile ?? env.WORKFLOW_FILE ?? DEFAULT_WORKFLOW_FILE,
    patSecret,
    // The two the loop cannot run without: one buys tokens from Anthropic, the
    // other buys the ability to retrigger on GitHub. A stated list replaces
    // both rather than adding to them, matching `pluginDirs`.
    requiredSecrets: input.requiredSecrets ??
      parseNameList(env.REQUIRED_SECRETS) ?? [OAUTH_TOKEN_SECRET, patSecret]
  }

  // Omitted rather than defaulted: an unstated repo is one `gh` infers from
  // the checkout, and an unstated pin means there is nothing to compare
  // against — neither is a value this may fabricate.
  const repo = input.repo ?? env.GITHUB_REPOSITORY
  if (repo) resolved.repo = repo

  const promptFile = input.promptFile ?? env.PROMPT_FILE
  if (promptFile) resolved.promptFile = promptFile

  const cliVersion = input.cliVersion ?? env.CLI_VERSION
  if (cliVersion) resolved.cliVersion = cliVersion

  if (input.cwd) resolved.cwd = input.cwd

  return resolved
}

/** A comma-separated env-var list, or undefined when the variable is unset. */
function parseNameList(raw: string | undefined): string[] | undefined {
  if (raw === undefined) return undefined
  return raw
    .split(',')
    .map((name) => name.trim())
    .filter(Boolean)
}
