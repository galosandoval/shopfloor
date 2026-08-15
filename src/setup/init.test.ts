/**
 * The pure half of `shopfloor init` (shopfloor#43): a setup verdict and the
 * project's own facts in, the list of writes out. No IO and no mocking — which
 * is the whole reason the decision lives apart from the writers.
 *
 * Three repositories are covered here because they are the three states a
 * re-runnable command has to be right about: fresh, partially configured, and
 * already configured. The third is the one that makes `init` safe to run
 * twice.
 */

import { planInit, formatInitPlan, type InitInput, type InitPlan } from './init'
import { buildPromptScaffold, buildWorkflowScaffold } from './scaffold'
import { evaluateSetup, REQUIRED_LABELS, type SetupFacts } from './setup'

const PROMPT_FILE = 'agent/implement/prompt.md'
const WORKFLOW_FILE = '.github/workflows/agent-implement.yml'

const PROJECT = {
  lockfiles: ['pnpm-lock.yaml'],
  packageScripts: { typecheck: 'tsc --noEmit', test: 'vitest run' }
}

/**
 * A prompt whose environment is fenced and filled but which substitutes
 * nothing — fenced, so the question is whether `init` rewrites it, not whether
 * it can find the half it fills.
 */
const TOKENLESS_PROMPT = buildPromptScaffold(PROJECT).replace(
  /\{\{[A-Z0-9_]+\}\}/g,
  'nothing'
)

/** A repository with nothing set up at all: no labels, no prompt, no workflow. */
function freshFacts(overrides: Partial<SetupFacts> = {}): SetupFacts {
  return {
    requiredSecrets: ['CLAUDE_CODE_OAUTH_TOKEN', 'AGENT_PAT'],
    patSecret: 'AGENT_PAT',
    ghAuth: 'authenticated',
    ghTokenScopes: ['repo', 'workflow'],
    repoSecrets: [],
    repoLabels: [],
    promptTemplate: null,
    workflow: null,
    workflowFile: WORKFLOW_FILE,
    defaultBranchWorkflowFiles: [],
    ...overrides
  }
}

/** A repository `init` has already been run on, and whose operator merged the workflow. */
function configuredFacts(overrides: Partial<SetupFacts> = {}): SetupFacts {
  return freshFacts({
    repoSecrets: ['CLAUDE_CODE_OAUTH_TOKEN', 'AGENT_PAT'],
    repoLabels: [...REQUIRED_LABELS],
    promptTemplate: buildPromptScaffold(PROJECT),
    workflow: buildWorkflowScaffold({
      patSecret: 'AGENT_PAT',
      promptFile: PROMPT_FILE
    }),
    defaultBranchWorkflowFiles: ['agent-implement.yml'],
    ...overrides
  })
}

function plan(facts: SetupFacts): InitPlan {
  const input: InitInput = {
    facts,
    verdict: evaluateSetup(facts),
    project: PROJECT,
    promptFile: PROMPT_FILE
  }
  return planInit(input)
}

/** The files a plan writes, by path — every assertion below is about one write. */
function writes(result: InitPlan): Record<string, string> {
  return Object.fromEntries(
    result.actions
      .filter((action) => action.kind === 'write-file')
      .map((action) => [action.file, action.contents])
  )
}

describe('planInit on a fresh repository', () => {
  const result = plan(freshFacts())

  it('creates every label the vocabulary requires', () => {
    const labels = result.actions.find(
      (action) => action.kind === 'create-labels'
    )
    expect(labels?.kind === 'create-labels' && labels.labels).toEqual([
      ...REQUIRED_LABELS
    ])
  })

  it('scaffolds the prompt and the workflow, both as creations', () => {
    expect(Object.keys(writes(result)).sort()).toEqual(
      [PROMPT_FILE, WORKFLOW_FILE].sort()
    )
    for (const action of result.actions) {
      if (action.kind === 'write-file') expect(action.mode).toBe('create')
    }
  })

  it('fills the scaffolded prompt from the project rather than leaving a placeholder', () => {
    expect(writes(result)[PROMPT_FILE]).toContain('pnpm run typecheck')
  })

  it('names what it cannot write rather than reporting a fixed setup', () => {
    expect(result.unfixable.map((check) => check.id)).toContain('repo-secrets')
    expect(result.noop).toBe(false)
  })
})

describe('planInit on a partially configured repository', () => {
  it('creates only the labels that are missing', () => {
    const result = plan(freshFacts({ repoLabels: ['ready-for-agent'] }))
    const labels = result.actions.find(
      (action) => action.kind === 'create-labels'
    )
    expect(labels?.kind === 'create-labels' && labels.labels).toEqual(
      REQUIRED_LABELS.filter((label) => label !== 'ready-for-agent')
    )
  })

  it('leaves a correct file alone and rewrites only the wrong one', () => {
    const result = plan(configuredFacts({ promptTemplate: TOKENLESS_PROMPT }))
    expect(Object.keys(writes(result))).toEqual([PROMPT_FILE])
  })

  it('marks a rewrite of an existing file as an overwrite, never a creation', () => {
    const result = plan(configuredFacts({ promptTemplate: TOKENLESS_PROMPT }))
    const write = result.actions.find((action) => action.kind === 'write-file')
    expect(write?.kind === 'write-file' && write.mode).toBe('overwrite')
  })

  it('rewrites a workflow that never references the PAT', () => {
    const result = plan(
      configuredFacts({
        workflow: `name: Agent implement
on:
  issues:
    types: [labeled]
  workflow_run:
    types: [completed]
jobs:
  go:
    steps:
      - uses: actions/checkout@v4
`
      })
    )
    expect(Object.keys(writes(result))).toEqual([WORKFLOW_FILE])
  })

  it('refills an environment block still carrying the sentinel', () => {
    const stale = buildPromptScaffold({ lockfiles: [], packageScripts: null })
    const result = plan(configuredFacts({ promptTemplate: stale }))
    expect(writes(result)[PROMPT_FILE]).toContain('pnpm install')
  })

  it('leaves an unfenced prompt alone and says why', () => {
    const unfenced = buildPromptScaffold(PROJECT).replace(
      /<!-- \/?shopfloor:environment -->/g,
      ''
    )
    const result = plan(configuredFacts({ promptTemplate: unfenced }))
    expect(writes(result)[PROMPT_FILE]).toBeUndefined()
    expect(result.skipped.map((skip) => skip.what)).toContain(PROMPT_FILE)
  })

  it('keeps a filled environment block when it rewrites for a token', () => {
    const theirs = buildPromptScaffold(PROJECT)
      .replace(/\{\{ISSUE_TITLE\}\}/, 'nothing')
      .replace('This work is not done until', 'Seed the database first. Then')
    const written = writes(plan(configuredFacts({ promptTemplate: theirs })))[
      PROMPT_FILE
    ]

    // Their line survives a rewrite that was about a missing token.
    expect(written).toContain('Seed the database first.')
    expect(written).toContain('{{ISSUE_TITLE}}')
  })

  it('does not offer to rewrite its own sentinel with the same sentinel', () => {
    // A project stating nothing the block can be filled from: the scaffold
    // init already wrote is the best this can do, so a second run must not put
    // an overwrite in front of the operator forever.
    const unfillable = { lockfiles: [], packageScripts: null }
    const result = planInit({
      facts: configuredFacts({
        promptTemplate: buildPromptScaffold(unfillable)
      }),
      verdict: evaluateSetup(
        configuredFacts({ promptTemplate: buildPromptScaffold(unfillable) })
      ),
      project: unfillable,
      promptFile: PROMPT_FILE
    })

    expect(result.actions).toEqual([])
    expect(result.skipped.map((skip) => skip.what)).toContain(PROMPT_FILE)
  })

  it('does not claim to have fixed a block it could only leave a sentinel in', () => {
    const unfillable = { lockfiles: [], packageScripts: null }
    // Tokens wrong and the block empty, so the rewrite happens for the tokens
    // — and leaves a block this project still cannot fill.
    const facts = configuredFacts({
      promptTemplate:
        '# No tokens\n<!-- shopfloor:environment -->\n<!-- /shopfloor:environment -->'
    })
    const result = planInit({
      facts,
      verdict: evaluateSetup(facts),
      project: unfillable,
      promptFile: PROMPT_FILE
    })

    expect(writes(result)[PROMPT_FILE]).toContain('TODO(shopfloor)')
    expect(result.unfixable.map((check) => check.id)).toContain(
      'prompt-environment-block'
    )
  })

  it('does not create labels it could not read', () => {
    const result = plan(configuredFacts({ repoLabels: 'unknown' }))
    expect(
      result.actions.some((action) => action.kind === 'create-labels')
    ).toBe(false)
    expect(result.skipped.map((skip) => skip.what)).toContain(
      'label vocabulary'
    )
  })

  it('does not rewrite a workflow whose only fault is not being merged yet', () => {
    const result = plan(configuredFacts({ defaultBranchWorkflowFiles: [] }))
    expect(writes(result)[WORKFLOW_FILE]).toBeUndefined()
    expect(result.unfixable.map((check) => check.id)).toContain(
      'workflow-run-prerequisites'
    )
  })

  it('names the merge it cannot do after scaffolding a workflow', () => {
    // Scaffolding the file does not put it on the default branch, and that is
    // where `workflow_run` fires from. With no workflow on disk that check
    // reports unknown rather than failing, so nothing else would say it.
    const fresh = plan(freshFacts())
    expect(writes(fresh)[WORKFLOW_FILE]).toBeDefined()
    expect(fresh.next.join(' ')).toContain(WORKFLOW_FILE)
    expect(formatInitPlan(fresh)).toMatch(/default branch/)

    // A merged workflow being rewritten needs no such step.
    const merged = plan(
      configuredFacts({ workflow: 'name: Ours\non:\n  push:\n' })
    )
    expect(merged.next).toEqual([])
  })
})

describe('planInit on a configured repository', () => {
  it('is a no-op — running it twice writes nothing', () => {
    const result = plan(configuredFacts())
    expect(result.actions).toEqual([])
    expect(result.noop).toBe(true)
  })

  it('stays a no-op against the files it wrote on the first run', () => {
    const first = plan(freshFacts())
    const written = writes(first)
    const second = plan(
      configuredFacts({
        promptTemplate: written[PROMPT_FILE],
        workflow: written[WORKFLOW_FILE]
      })
    )
    expect(second.actions).toEqual([])
  })
})

describe('formatInitPlan', () => {
  it('names every write, every skip, and everything left for the operator', () => {
    const report = formatInitPlan(plan(freshFacts()))
    expect(report).toContain(PROMPT_FILE)
    expect(report).toContain(WORKFLOW_FILE)
    expect(report).toContain('CLAUDE_CODE_OAUTH_TOKEN')
  })

  it('says so plainly when there is nothing to do', () => {
    expect(formatInitPlan(plan(configuredFacts()))).toMatch(/nothing to do/i)
  })
})
