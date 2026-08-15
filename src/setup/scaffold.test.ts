/**
 * The scaffolder's pure half: what `init` would write, decided from the
 * project's own lockfile and scripts. No IO — `run-init.ts` reads the project
 * root and hands the facts over.
 *
 * The load-bearing assertion in this file is the sentinel one. A block filled
 * with a plausible guess is the `standardsDir` failure shape; a block carrying
 * `TODO(shopfloor)` is a failure the doctor already refuses on.
 */

import {
  ENVIRONMENT_UNFILLED_SENTINEL,
  evaluateSetup,
  PROMPT_TOKENS,
  type SetupFacts
} from './setup'
import {
  buildEnvironmentBlock,
  buildPromptScaffold,
  buildWorkflowScaffold,
  type ProjectFacts
} from './scaffold'

function project(overrides: Partial<ProjectFacts> = {}): ProjectFacts {
  return {
    lockfiles: ['pnpm-lock.yaml'],
    packageScripts: { typecheck: 'tsc --noEmit', test: 'vitest run' },
    ...overrides
  }
}

/**
 * A setup whose only interesting field is the one under test — these suites
 * ask what the doctor says about a scaffold, not about a repository.
 */
function factsWith(overrides: Partial<SetupFacts>): SetupFacts {
  return {
    requiredSecrets: [],
    patSecret: 'AGENT_PAT',
    ghAuth: 'authenticated',
    ghTokenScopes: ['workflow'],
    repoSecrets: [],
    repoLabels: [],
    promptTemplate: null,
    workflow: null,
    workflowFile: '.github/workflows/agent-implement.yml',
    defaultBranchWorkflowFiles: 'unknown',
    ...overrides
  }
}

describe('buildEnvironmentBlock', () => {
  it('fills the package manager from the lockfile', () => {
    const block = buildEnvironmentBlock(project())
    expect(block).toContain('pnpm install')
    expect(block).not.toContain(ENVIRONMENT_UNFILLED_SENTINEL)
  })

  it('names each package manager from its own lockfile', () => {
    const installOf = (lockfile: string) =>
      buildEnvironmentBlock(project({ lockfiles: [lockfile] }))

    expect(installOf('bun.lock')).toContain('bun install')
    expect(installOf('yarn.lock')).toContain('yarn install')
    expect(installOf('package-lock.json')).toContain('npm ci')
  })

  it('builds the gate from the scripts the project actually declares', () => {
    const block = buildEnvironmentBlock(
      project({
        packageScripts: {
          typecheck: 'tsc --noEmit',
          lint: 'eslint .',
          test: 'vitest run',
          dev: 'vite'
        }
      })
    )
    expect(block).toContain(
      'pnpm run typecheck && pnpm run lint && pnpm run test'
    )
    // A script that is not a gate is not silently promoted into one.
    expect(block).not.toContain('pnpm run dev')
  })

  it('writes the sentinel rather than guessing a package manager', () => {
    const block = buildEnvironmentBlock(project({ lockfiles: [] }))
    expect(block).toContain(ENVIRONMENT_UNFILLED_SENTINEL)
    expect(block).toMatch(/no lockfile/i)
    // The half it could determine is still filled.
    expect(block).toContain('typecheck')
  })

  it('writes the sentinel rather than inventing a gate', () => {
    expect(
      buildEnvironmentBlock(project({ packageScripts: { dev: 'vite' } }))
    ).toContain(ENVIRONMENT_UNFILLED_SENTINEL)
    expect(buildEnvironmentBlock(project({ packageScripts: null }))).toContain(
      ENVIRONMENT_UNFILLED_SENTINEL
    )
  })

  it('never emits an empty line where a value belongs', () => {
    const block = buildEnvironmentBlock({
      lockfiles: [],
      packageScripts: null
    })
    expect(block.trim()).not.toBe('')
    for (const line of block.split('\n').filter(Boolean)) {
      expect(line.trim()).not.toMatch(/[:—-]\s*$/)
    }
  })
})

describe('buildPromptScaffold', () => {
  const prompt = buildPromptScaffold(project())

  it('carries every substituted token and no unrecognized one', () => {
    for (const token of PROMPT_TOKENS) {
      expect(prompt).toContain(`{{${token}}}`)
    }
    const carried = prompt.match(/\{\{\s*[A-Z0-9_]+\s*\}\}/g) ?? []
    const unrecognized = carried
      .map((token) => token.replace(/[{}\s]/g, ''))
      .filter(
        (token) =>
          !PROMPT_TOKENS.includes(token as (typeof PROMPT_TOKENS)[number])
      )
    expect(unrecognized).toEqual([])
  })

  it('fences the environment half and fills it', () => {
    expect(prompt).toContain('<!-- shopfloor:environment -->')
    expect(prompt).toContain('<!-- /shopfloor:environment -->')
    expect(prompt).toContain('pnpm install')
  })

  it('passes the doctor it was scaffolded to satisfy', () => {
    const notOk = evaluateSetup(factsWith({ promptTemplate: prompt }))
      .checks.filter((check) => check.status !== 'ok')
      .map((check) => check.id)
    expect(notOk).not.toContain('prompt-tokens')
    expect(notOk).not.toContain('prompt-environment-block')
  })

  it('keeps an environment block it is handed rather than rebuilding it', () => {
    const theirs =
      '<!-- shopfloor:environment -->\nRun `make check`.\n<!-- /shopfloor:environment -->'
    const kept = buildPromptScaffold(project(), theirs)
    expect(kept).toContain('Run `make check`.')
    expect(kept).not.toContain('pnpm install')
  })
})

describe('buildWorkflowScaffold', () => {
  const workflow = buildWorkflowScaffold({
    patSecret: 'AGENT_PAT',
    promptFile: 'agent/implement/prompt.md'
  })

  it('is wired to both admitted trigger events and references the PAT', () => {
    const failing = evaluateSetup(
      // Merged, because that half is the operator's next step rather than
      // anything the file itself can be right or wrong about.
      factsWith({
        workflow,
        defaultBranchWorkflowFiles: ['agent-implement.yml']
      })
    ).failures.map((failure) => failure.id)

    expect(failing).not.toContain('workflow-triggers')
    expect(failing).not.toContain('workflow-run-prerequisites')
  })

  it('runs the job on the machine edge, not only on the human one', () => {
    // `github.event.label` is null on a workflow_run event, so a bare label
    // condition would leave that trigger firing a job that never runs — a
    // workflow that passes its own doctor while the loop half of it is dead.
    const condition = workflow.slice(workflow.indexOf('    if:'))
    expect(condition).toContain("github.event_name != 'issues'")
    expect(condition).toContain("github.event.label.name == 'ready-for-agent'")
  })

  it('follows a renamed PAT secret', () => {
    const renamed = buildWorkflowScaffold({
      patSecret: 'LOOP_PAT',
      promptFile: 'agent/implement/prompt.md'
    })
    expect(renamed).toContain('secrets.LOOP_PAT')
    expect(renamed).not.toContain('secrets.AGENT_PAT')
  })

  it('points the run at the prompt it scaffolds beside it', () => {
    expect(workflow).toContain('agent/implement/prompt.md')
  })

  it('marks the workflow_run source it cannot determine', () => {
    expect(workflow).toContain(ENVIRONMENT_UNFILLED_SENTINEL)
  })

  it('installs the CLI the harness spawns, rather than assuming it is there', () => {
    // `spawnClaude` runs `claude` from PATH and nothing else on a fresh runner
    // puts it there — a workflow without this step fails after checkout.
    expect(workflow).toContain('npm install -g @anthropic-ai/claude-code@')
  })

  it('pins the CLI and this package when it is told what they are', () => {
    const pinned = buildWorkflowScaffold({
      patSecret: 'AGENT_PAT',
      promptFile: 'agent/implement/prompt.md',
      cliVersion: '2.1.220',
      packageVersion: '0.11.0'
    })
    expect(pinned).toContain('@anthropic-ai/claude-code@2.1.220')
    expect(pinned).toContain('@galosandoval/shopfloor@0.11.0')
    // The run compares itself against the same pin the job installed.
    expect(pinned).toContain("CLI_VERSION: '2.1.220'")
    // The version sentinels are gone; the workflow_run source is not — that
    // one is a fact about the consumer's pipeline, not about a version.
    expect(pinned).not.toContain(`claude-code@${ENVIRONMENT_UNFILLED_SENTINEL}`)
  })

  it('writes the sentinel rather than floating either version', () => {
    // An unpinned `npx` changes what the loop runs on a schedule nobody set,
    // and a floating CLI turns `cli-version-pin` into noise.
    expect(workflow).toContain(
      `@anthropic-ai/claude-code@${ENVIRONMENT_UNFILLED_SENTINEL}`
    )
    expect(workflow).toContain(
      `@galosandoval/shopfloor@${ENVIRONMENT_UNFILLED_SENTINEL}`
    )
  })

  it('is refused by the doctor while anything in it is unfilled', () => {
    // The whole point of the sentinel: a scaffolded workflow must not read
    // green. Without this the edge passes `workflow-triggers` and fires from
    // a workflow name nobody wrote.
    const failing = evaluateSetup(
      factsWith({
        workflow,
        defaultBranchWorkflowFiles: ['agent-implement.yml']
      })
    ).failures.map((failure) => failure.id)
    expect(failing).toContain('workflow-unfilled')

    const filled = evaluateSetup(
      factsWith({
        workflow: workflow.replaceAll(ENVIRONMENT_UNFILLED_SENTINEL, 'x'),
        defaultBranchWorkflowFiles: ['agent-implement.yml']
      })
    ).failures.map((failure) => failure.id)
    expect(filled).not.toContain('workflow-unfilled')
  })
})
