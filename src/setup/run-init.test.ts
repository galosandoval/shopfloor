/**
 * Wiring for `init`'s shell: that every value it resolves reaches the plan,
 * and that every action the plan names reaches the repository. The decisions
 * are tested pure in `init.test.ts`; asserting them again here would prove
 * nothing about whether a writer is called — the failure this file exists to
 * catch.
 *
 * `gh` is stubbed at the process boundary; the filesystem is real, in a temp
 * checkout, because what is under test is whether the writes land where the
 * probe then reads them.
 */

import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import {
  calls,
  execStubModule,
  resetExecStub,
  routeExecStub
} from '../process/exec-stub.test-helper'
import { runInit } from './run-init'
import { REQUIRED_LABELS } from '../issue-state/vocabulary'
import { ENVIRONMENT_UNFILLED_SENTINEL } from './setup'

vi.mock('node:child_process', () => execStubModule())

let cwd: string

const PROMPT_FILE = 'agent/implement/prompt.md'
const WORKFLOW_FILE = '.github/workflows/agent-implement.yml'

/** Every probe answers; a repository with no labels and nothing scaffolded. */
function stubGh(labels: string[] = []): void {
  routeExecStub([
    {
      match: /^gh auth status/,
      response: { stdout: "  - Token scopes: 'repo', 'workflow'" }
    },
    {
      match: /^gh repo view --json nameWithOwner/,
      response: { stdout: '{"nameWithOwner":"me/repo"}' }
    },
    {
      match: /^gh repo view .*defaultBranchRef/,
      response: { stdout: '{"defaultBranchRef":{"name":"main"}}' }
    },
    {
      match: /^gh secret list/,
      response: {
        stdout: '[{"name":"CLAUDE_CODE_OAUTH_TOKEN"},{"name":"AGENT_PAT"}]'
      }
    },
    { match: /organization-secrets/, response: { stdout: '{"secrets":[]}' } },
    {
      match: /^gh label list/,
      response: {
        stdout: JSON.stringify(labels.map((name) => ({ name })))
      }
    },
    { match: /^gh api repos/, response: { stdout: '[]' } },
    { match: /^gh label create/, response: { stdout: '' } },
    { match: /^claude --version/, response: { stdout: '2.1.220' } }
  ])
}

beforeEach(() => {
  resetExecStub()
  cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'shopfloor-init-'))
  fs.writeFileSync(
    path.join(cwd, 'package.json'),
    JSON.stringify({ scripts: { typecheck: 'tsc --noEmit', test: 'vitest' } })
  )
  fs.writeFileSync(path.join(cwd, 'pnpm-lock.yaml'), '')
  stubGh()
})

afterEach(() => {
  fs.rmSync(cwd, { recursive: true, force: true })
})

/** Never asked in these runs unless a test says so — an unexpected ask fails loudly. */
const refuse = async () => false

function read(file: string): string {
  return fs.readFileSync(path.join(cwd, file), 'utf8')
}

describe('runInit', () => {
  it('scaffolds a fresh repository and creates its labels', async () => {
    const result = await runInit({ cwd, env: {}, confirm: refuse })

    expect(result.errors).toEqual([])
    expect(fs.existsSync(path.join(cwd, PROMPT_FILE))).toBe(true)
    expect(fs.existsSync(path.join(cwd, WORKFLOW_FILE))).toBe(true)

    const created = calls
      .filter((call) => call[1] === 'label' && call[2] === 'create')
      .map((call) => call[3])
    expect(created).toEqual([...REQUIRED_LABELS])
  })

  it('fills the environment block from this project, not from a placeholder', async () => {
    await runInit({ cwd, env: {}, confirm: refuse })
    const prompt = read(PROMPT_FILE)
    expect(prompt).toContain('pnpm install')
    expect(prompt).toContain('pnpm run typecheck && pnpm run test')
    expect(prompt).not.toContain(ENVIRONMENT_UNFILLED_SENTINEL)
  })

  it('writes the sentinel into a project whose commands it cannot read', async () => {
    fs.rmSync(path.join(cwd, 'pnpm-lock.yaml'))
    fs.rmSync(path.join(cwd, 'package.json'))
    await runInit({ cwd, env: {}, confirm: refuse })
    expect(read(PROMPT_FILE)).toContain(ENVIRONMENT_UNFILLED_SENTINEL)
  })

  it('is a no-op on the second run', async () => {
    await runInit({ cwd, env: {}, confirm: refuse })
    // The repository now has what the first run wrote.
    const before = read(PROMPT_FILE)

    resetExecStub()
    stubGh([...REQUIRED_LABELS])
    const second = await runInit({ cwd, env: {}, confirm: refuse })

    expect(second.plan.noop).toBe(true)
    expect(second.applied).toEqual([])
    expect(read(PROMPT_FILE)).toBe(before)
    expect(calls.some((call) => call[2] === 'create')).toBe(false)
  })

  it('stays a no-op on a project it could not fill the block for', async () => {
    // The sentinel it wrote fails the doctor for good — a run that re-planned
    // the same overwrite would ask the operator to approve it, forever, over a
    // file init itself wrote.
    fs.rmSync(path.join(cwd, 'pnpm-lock.yaml'))
    fs.rmSync(path.join(cwd, 'package.json'))
    await runInit({ cwd, env: {}, confirm: refuse })

    resetExecStub()
    stubGh([...REQUIRED_LABELS])
    const second = await runInit({ cwd, env: {}, confirm: refuse })

    expect(second.plan.actions).toEqual([])
    expect(second.plan.skipped.map((skip) => skip.what)).toContain(PROMPT_FILE)
  })

  it('never overwrites without an answer, and leaves the file as it was', async () => {
    fs.mkdirSync(path.join(cwd, path.dirname(PROMPT_FILE)), {
      recursive: true
    })
    const theirs = [
      '# Their own prompt',
      '<!-- shopfloor:environment -->',
      'Run `make check`.',
      '<!-- /shopfloor:environment -->'
    ].join('\n')
    fs.writeFileSync(path.join(cwd, PROMPT_FILE), theirs)

    const declined = await runInit({ cwd, env: {}, confirm: refuse })
    expect(read(PROMPT_FILE)).toBe(theirs)
    expect(declined.declined).toHaveLength(1)

    const accepted = await runInit({
      cwd,
      env: {},
      confirm: async () => true
    })
    expect(read(PROMPT_FILE)).toContain('{{ISSUE_NUMBER}}')
    expect(accepted.declined).toEqual([])
  })

  it('asks about the file it is about to destroy, by name', async () => {
    fs.mkdirSync(path.join(cwd, '.github/workflows'), { recursive: true })
    fs.writeFileSync(
      path.join(cwd, WORKFLOW_FILE),
      'name: Ours\non:\n  push:\n'
    )

    const asked: string[] = []
    await runInit({
      cwd,
      env: {},
      confirm: async (question) => {
        asked.push(question)
        return false
      }
    })
    expect(asked.join('\n')).toContain(WORKFLOW_FILE)
  })

  it('scaffolds where the caller pointed it, not only at the default', async () => {
    await runInit({
      cwd,
      env: {
        PROMPT_FILE: 'prompts/agent.md',
        WORKFLOW_FILE: '.github/workflows/loop.yml'
      },
      confirm: refuse
    })
    expect(fs.existsSync(path.join(cwd, 'prompts/agent.md'))).toBe(true)
    expect(fs.existsSync(path.join(cwd, '.github/workflows/loop.yml'))).toBe(
      true
    )
    // The workflow points the run at the prompt beside it, not at the default.
    expect(read('.github/workflows/loop.yml')).toContain('prompts/agent.md')
  })

  it('creates each label in the repository it was pointed at', async () => {
    await runInit({
      cwd,
      env: { GITHUB_REPOSITORY: 'them/theirs' },
      confirm: refuse
    })

    const create = calls.find(
      (call) => call[1] === 'label' && call[2] === 'create'
    )
    expect(create).toContain('--repo')
    expect(create?.[create.indexOf('--repo') + 1]).toBe('them/theirs')
    // And with what GitHub needs to make the vocabulary readable.
    expect(create).toContain('--color')
    expect(create).toContain('--description')
  })

  it('pins the scaffolded workflow to versions it read, not to a sentinel', async () => {
    // This package's own version comes from the manifest that shipped it, and
    // the CLI pin from the same CLI_VERSION the doctor compares against. Both
    // unpinned would leave the workflow fetching whatever npm published today.
    await runInit({ cwd, env: { CLI_VERSION: '2.1.220' }, confirm: refuse })
    const workflow = read(WORKFLOW_FILE)

    expect(workflow).toContain('@anthropic-ai/claude-code@2.1.220')
    expect(workflow).toMatch(
      /@galosandoval\/shopfloor@\d+\.\d+\.\d+ shopfloor-run-phase/
    )
  })

  it('follows a renamed PAT secret into what it scaffolds', async () => {
    await runInit({
      cwd,
      env: { AGENT_PAT_SECRET: 'LOOP_PAT' },
      confirm: refuse
    })
    expect(read(WORKFLOW_FILE)).toContain('secrets.LOOP_PAT')
  })

  it('reports a failed write rather than throwing', async () => {
    routeExecStub([
      { match: /^gh label create/, response: { fails: 1 } },
      {
        match: /^gh auth status/,
        response: { stdout: "Token scopes: 'repo'" }
      },
      { match: /^gh/, response: { stdout: '[]' } }
    ])

    const result = await runInit({ cwd, env: {}, confirm: refuse })
    expect(result.errors).toHaveLength(1)
    expect(result.errors[0]).toContain('label(s)')
    // The failure does not stop the writes that follow it.
    expect(fs.existsSync(path.join(cwd, PROMPT_FILE))).toBe(true)
  })
})
