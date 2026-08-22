/**
 * What `shopfloor init` (shopfloor#43) writes: the agent workflow, the prompt
 * skeleton, and — the part that is the point — the prompt's **filled**
 * environment block, derived from the project's own lockfile and
 * `package.json` scripts.
 *
 * Pure, and split from `init.ts` for the reason that file would otherwise
 * change for two: the decision of *what* to write is this package's, while
 * these templates track GitHub Actions' YAML and the prompt vocabulary, and
 * they move on their own schedule.
 *
 * **Why filling matters more than scaffolding.** A skeleton with unfilled
 * placeholders fails the way `standardsDir` failed — present, plausible,
 * wrong, and silent. So every value here is either read off the project or
 * written as {@link ENVIRONMENT_UNFILLED_SENTINEL}, which
 * `prompt-environment-block` already refuses on. Nothing in between: a guess
 * about a consumer's commands is indistinguishable from a fact about them.
 */

import { ENTRY_LABEL } from '../issue-state/vocabulary'
import {
  ENVIRONMENT_BLOCK_END,
  ENVIRONMENT_BLOCK_START,
  ENVIRONMENT_UNFILLED_SENTINEL
} from './setup'

/**
 * What `init` reads about the project itself, beyond the setup verdict. Two
 * facts, because two are what the environment block can be built from without
 * asking a human: which package manager runs a script, and which scripts there
 * are to run.
 */
export interface ProjectFacts {
  /** Lockfile names found at the project root, in whatever order they were read. */
  lockfiles: string[]
  /** `scripts` from the project's `package.json`; null when there was none to read. */
  packageScripts: Record<string, string> | null
}

/**
 * Package managers by the lockfile that identifies them. Ordered, so a
 * repository carrying two lockfiles resolves to one answer rather than to
 * whichever `readdir` happened to return first.
 *
 * `npm ci` rather than `npm install` — the lockfile is present by construction
 * here, and the install a scaffolded environment describes is the reproducible
 * one.
 */
const PACKAGE_MANAGERS = [
  { lockfile: 'bun.lock', run: 'bun run', install: 'bun install' },
  { lockfile: 'bun.lockb', run: 'bun run', install: 'bun install' },
  { lockfile: 'pnpm-lock.yaml', run: 'pnpm run', install: 'pnpm install' },
  { lockfile: 'yarn.lock', run: 'yarn run', install: 'yarn install' },
  { lockfile: 'package-lock.json', run: 'npm run', install: 'npm ci' }
] as const

/** The lockfile names worth looking for at a project root — the probe's whole list. */
export const LOCKFILE_NAMES: readonly string[] = PACKAGE_MANAGERS.map(
  (manager) => manager.lockfile
)

/**
 * The scripts that make up a gate, in the order they belong in one: the cheap
 * checks first, so a failing run fails on the fast command. Only these are
 * promoted — a `dev` script is not a gate, and a scaffolder that chained every
 * script would write a command nobody could run.
 */
const GATE_SCRIPTS = ['typecheck', 'lint', 'test'] as const

/**
 * The environment half of a prompt, fenced and filled — the ~60% of a real
 * prompt that is local, and that this package otherwise never ships. It ships
 * the *shape* here and reads the values off the project; anything it cannot
 * read is a sentinel rather than prose.
 */
export function buildEnvironmentBlock(project: ProjectFacts): string {
  const manager = PACKAGE_MANAGERS.find((candidate) =>
    project.lockfiles.includes(candidate.lockfile)
  )
  const gate = manager && gateCommand(manager.run, project.packageScripts)

  return [
    ENVIRONMENT_BLOCK_START,
    '',
    manager
      ? `Install dependencies with \`${manager.install}\`.`
      : `${ENVIRONMENT_UNFILLED_SENTINEL}: no lockfile at the project root, so ` +
        'the package manager and its install command are undetermined — state them here.',
    '',
    gate
      ? `This work is not done until \`${gate}\` passes.`
      : `${ENVIRONMENT_UNFILLED_SENTINEL}: ${undeterminedGate(project)} — ` +
        'state the command that must pass before this work is done.',
    '',
    ENVIRONMENT_BLOCK_END
  ].join('\n')
}

/** The gate scripts this project declares, chained; undefined when it declares none. */
function gateCommand(
  run: string,
  scripts: Record<string, string> | null
): string | undefined {
  if (!scripts) return undefined
  const present = GATE_SCRIPTS.filter((script) => script in scripts)
  return present.length === 0
    ? undefined
    : present.map((script) => `${run} ${script}`).join(' && ')
}

/**
 * Why the gate could not be built. It names what *was* found alongside what
 * was not: a lockfile-less project with a `test` script needs a human to write
 * one word, and a sentinel that withheld the script names would make them go
 * looking for something this already read.
 */
function undeterminedGate(project: ProjectFacts): string {
  if (project.packageScripts === null) return 'no readable package.json'

  const declared = GATE_SCRIPTS.filter(
    (script) => project.packageScripts && script in project.packageScripts
  )
  if (declared.length === 0) {
    return `package.json declares none of ${GATE_SCRIPTS.join(', ')}`
  }
  return (
    'no lockfile, so nothing names the command that runs a script; ' +
    `package.json declares ${declared.join(', ')}`
  )
}

/**
 * The prompt skeleton — a shim to the installed skills plugin, not a procedure
 * of its own. It carries the substituted tokens and nothing else in
 * `{{…}}` shape, because a token this package does not substitute is one a run
 * refuses to spawn over.
 *
 * What it deliberately does not carry: how to write code. That is procedure,
 * it ships as skills, and duplicating it into every consumer's prompt is the
 * drift `CONTEXT.md` keeps standards and procedures apart to avoid.
 *
 * @param environment - A fenced block to keep verbatim, for a rewrite over a
 * prompt whose environment a human already filled. Rebuilding it from
 * {@link ProjectFacts} would replace what they wrote with what this can read,
 * which on a project it cannot read is the sentinel — a rewrite that fixed the
 * tokens by destroying the environment.
 */
export function buildPromptScaffold(
  project: ProjectFacts,
  environment = buildEnvironmentBlock(project)
): string {
  return `# Implement issue #{{ISSUE_NUMBER}}

**{{ISSUE_TITLE}}**

Read the issue with \`gh issue view {{ISSUE_NUMBER}}\` and implement what it
asks for. You are already on branch \`{{BRANCH}}\`; commit your work there.

Follow the repository's own standards — \`CLAUDE.md\` and whatever it points
at — and the \`implement\` skill for how to carry the work out.

## What previous attempts left you

\`{{ATTEMPTS_DIR}}\` holds one file per previous attempt on this issue. Read
**all** of them before you start. Each separates the harness's own
observations, which are facts, from the previous agent's claims, which are not.
An empty or absent directory means this is the first attempt.

## What this run must leave behind

- The implementation, committed on \`{{BRANCH}}\`.
- The pull request description, written to \`{{PR_DESCRIPTION_FILE}}\`.
- What you verified and how, written to \`{{VERIFY_REPORT_FILE}}\`.
- Any screenshots, saved under \`{{SCREENSHOTS_DIR}}\`.
- Your own account of this attempt, written to \`{{HANDOFF_CLAIMS_FILE}}\`:
  what you tried, what you abandoned and why, what you believe the root cause
  is. Write it as you go — a run that is cut off still leaves what it had.

## Environment

${environment}
`
}

/** The CLI the harness spawns. Installed by the scaffold, because nothing else does. */
const CLAUDE_CLI_PACKAGE = '@anthropic-ai/claude-code'

/** This package, as the scaffolded workflow invokes it. */
const SHOPFLOOR_PACKAGE = '@galosandoval/shopfloor'

/** What the workflow scaffold has to be told, rather than can read for itself. */
export interface WorkflowScaffoldInput {
  /** The secret holding the PAT — the machine edge is load-bearing on it. */
  patSecret: string
  /** Repository-relative path to the prompt scaffolded alongside this. */
  promptFile: string
  /**
   * The `claude` version to install and pin to, if the caller stated one.
   * Unstated writes the sentinel: a floating install is a version this
   * package's own `cli-version-pin` check then compares against nothing.
   */
  cliVersion?: string
  /**
   * The version of this package to invoke, if it could be read — normally the
   * one doing the scaffolding, so the workflow keeps running against the
   * harness it was written for rather than against whatever `npx` fetches next.
   */
  packageVersion?: string
}

/**
 * The agent workflow, wired to both admitted trigger events.
 *
 * **Two jobs, and the split is the whole shape of it** (design review finding
 * 2). `admit` runs `shopfloor-admit` with nothing installed but this package
 * and `gh`: classification, the spend gate, the concurrency narrowing, and the
 * attempt ceiling, all in front of the runner setup they exist to protect. The
 * expensive job runs one step — `shopfloor-run-phase` — which re-asks the same
 * question rather than trusting the answer, then owns the branch, the run, the
 * pull request, and the issue's state.
 *
 * What is *not* here is the point: no slug pipeline, no `gh pr create`, no
 * label swaps behind `|| true`, and no step deciding which issue a finished CI
 * run belongs to. Every one of those is now a typed, tested function reading
 * the payload the runner already wrote to disk.
 *
 * **Everything it cannot know is a sentinel, not a guess** — and
 * `workflow-unfilled` refuses on every one of them, so a scaffolded workflow
 * cannot read green while an edge of it is dead. There are two left: which CI
 * workflow's completion retriggers the loop (a plausible wrong name is an edge
 * that silently never fires), and which `claude` version to install.
 *
 * **Both `npx` invocations and the CLI install are pinned.** A workflow that
 * fetched the latest of either would change what it runs on a schedule nobody
 * set, and the `cli-version-pin` check exists precisely because a drifting CLI
 * is a run that fails in a way the transcript does not explain.
 */
export function buildWorkflowScaffold(input: WorkflowScaffoldInput): string {
  const pat = `\${{ secrets.${input.patSecret} }}`
  const cliVersion = input.cliVersion ?? ENVIRONMENT_UNFILLED_SENTINEL
  const shopfloor = input.packageVersion
    ? `${SHOPFLOOR_PACKAGE}@${input.packageVersion}`
    : `${SHOPFLOOR_PACKAGE}@${ENVIRONMENT_UNFILLED_SENTINEL}`
  return `name: Agent implement

# Scaffolded by \`shopfloor init\`. The loop's two edges: a human labelling an
# issue, and CI completing on a branch the agent pushed.
#
# This file has to be merged to the default branch: \`workflow_run\` fires from
# nowhere else, so the machine edge stays dead until it is there.
on:
  issues:
    types: [labeled]
  workflow_run:
    workflows: ['${ENVIRONMENT_UNFILLED_SENTINEL}: name the CI workflow whose completion retriggers the loop']
    types: [completed]

# One run per issue: a second label event while a run is in flight would put
# two agents on one branch.
concurrency:
  group: agent-implement-\${{ github.event.issue.number || github.run_id }}
  cancel-in-progress: false

jobs:
  # Nothing is installed here. This job answers "may this event start a run?"
  # — classification, the spend gate, the in-flight check, and the attempt
  # ceiling — before the runner pays for anything, and refuses non-zero when
  # the answer is no. An event the loop does not run on exits zero and skips
  # the job below, so ordinary label traffic never paints the repo red.
  #
  # It writes exactly once: a spent ceiling lands \`agent:exhausted\` and posts
  # the attempt trail here, because the job below is gated on this verdict and
  # so never runs to do it. That needs the PAT to be able to write issues.
  admit:
    # Filters the human edge without filtering the machine edge out of
    # existence: \`github.event.label\` is null on a workflow_run event, so a
    # bare label condition would make that trigger fire a job that never runs.
    # Redundant with what \`shopfloor-admit\` decides, and worth a line anyway:
    # it keeps ordinary label traffic from starting a runner at all.
    if: >-
      github.event_name != 'issues' ||
      github.event.label.name == '${ENTRY_LABEL}'
    runs-on: ubuntu-latest
    outputs:
      admitted: \${{ steps.admit.outputs.admitted }}
    steps:
      - id: admit
        env:
          GH_TOKEN: ${pat}
        run: |
          # The bin exits non-zero on a real refusal so that a caller who
          # ignores stdout is still stopped by it. This job does not ignore
          # stdout — it gates the expensive job on the verdict below — so a
          # refusal here is a skip rather than a red workflow. A run already in
          # flight, or a spent ceiling, is ordinary traffic, and a check that
          # paints the repository red for ordinary traffic is a check people
          # delete. The verdict is read and echoed either way; nothing is
          # swallowed.
          set +e
          verdict="$(npx --yes ${shopfloor} shopfloor-admit)"
          set -e
          echo "$verdict"
          echo "admitted=$(echo "$verdict" | jq -r '.admitted')" >> "$GITHUB_OUTPUT"

  run-phase:
    needs: admit
    if: needs.admit.outputs.admitted == 'true'
    runs-on: ubuntu-latest
    permissions:
      contents: write
      issues: write
      pull-requests: write
    steps:
      - uses: actions/checkout@v4
        with:
          # The PAT, not GITHUB_TOKEN: a push made with the built-in token
          # fires no downstream events, so the loop would run once and stop.
          token: ${pat}
          fetch-depth: 0

      - uses: actions/setup-node@v4
        with:
          node-version: 20

      # The harness spawns \`claude\` from PATH; nothing else on this runner
      # installs it. Pinned to the same version CLI_VERSION states below, so
      # \`cli-version-pin\` compares the run against what this job installed
      # rather than against whatever npm published this morning.
      - name: Install the Claude Code CLI
        run: npm install -g ${CLAUDE_CLI_PACKAGE}@${cliVersion}

      # The whole of the loop, in one step. It reads GITHUB_EVENT_PATH itself,
      # so nothing here names an issue, a branch, or a phase.
      - name: Run the phase
        env:
          CLAUDE_CODE_OAUTH_TOKEN: \${{ secrets.CLAUDE_CODE_OAUTH_TOKEN }}
          GH_TOKEN: ${pat}
          PROMPT_FILE: ${input.promptFile}
          CLI_VERSION: '${cliVersion}'
        run: npx --yes ${shopfloor} shopfloor-run-phase
`
}
