/**
 * Wiring for the doctor's probe: that every value it resolves actually reaches
 * the facts {@link evaluateSetup} judges. The verdict logic is tested pure in
 * `setup.test.ts`, and asserting it again here would prove nothing about
 * whether a probe is called — which is the failure this file exists to catch.
 *
 * `gh` and `claude` are stubbed at the process boundary; the filesystem is
 * real, in a temp checkout, for the same reason `run-plugin-dirs.test.ts` uses
 * one — what is under test is whether the reads find the layout that is
 * actually there.
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
import { probeSetup } from './probe-setup'
import { evaluateSetup } from './setup'

vi.mock('node:child_process', () => execStubModule())

let cwd: string

/** A checkout with a workflow, a prompt, and a second workflow to be named by `workflows:`. */
function writeCheckout(files: Record<string, string>): void {
  for (const [file, contents] of Object.entries(files)) {
    const target = path.join(cwd, file)
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.writeFileSync(target, contents)
  }
}

const AGENT_WORKFLOW = `name: Agent implement
on:
  issues:
    types: [labeled]
  workflow_run:
    workflows: [Test]
    types: [completed]
jobs:
  go:
    steps:
      - uses: actions/checkout@v4
        with:
          token: \${{ secrets.AGENT_PAT }}
`

beforeEach(() => {
  resetExecStub({ fails: 1 })
  cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'shopfloor-doctor-'))
  writeCheckout({
    '.github/workflows/agent-implement.yml': AGENT_WORKFLOW,
    '.github/workflows/test.yml': 'name: Test\non:\n  push:\n',
    'prompt.md': '# Implement {{ISSUE_NUMBER}}\n'
  })
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
      response: { stdout: '[{"name":"CLAUDE_CODE_OAUTH_TOKEN"}]' }
    },
    {
      match: /organization-secrets/,
      response: { stdout: '{"secrets":[{"name":"AGENT_PAT"}]}' }
    },
    {
      match: /^gh label list/,
      response: { stdout: '[{"name":"ready-for-agent"}]' }
    },
    {
      match: /^gh api repos/,
      response: {
        stdout: '[{"name":"agent-implement.yml"},{"name":"test.yml"}]'
      }
    },
    {
      match: /^claude --version/,
      response: { stdout: '2.1.220 (Claude Code)\n' }
    }
  ])
})

afterEach(() => {
  fs.rmSync(cwd, { recursive: true, force: true })
})

describe('probeSetup', () => {
  it('reaches every probe and lands each answer in the facts', async () => {
    const facts = await probeSetup({
      cwd,
      env: { PROMPT_FILE: 'prompt.md', CLI_VERSION: '2.1.220' }
    })

    expect(facts.ghAuth).toBe('authenticated')
    expect(facts.ghTokenScopes).toEqual(['repo', 'workflow'])
    // The PAT lives in an organization secret here — a correctly configured
    // setup that `gh secret list` alone would report as missing it.
    expect(facts.repoSecrets).toEqual(['CLAUDE_CODE_OAUTH_TOKEN', 'AGENT_PAT'])
    expect(facts.repoLabels).toEqual(['ready-for-agent'])
    expect(facts.runningCliVersion).toContain('2.1.220')
    expect(facts.pinnedCliVersion).toBe('2.1.220')
    expect(facts.promptTemplate).toContain('{{ISSUE_NUMBER}}')
    expect(facts.workflow).toContain('workflow_run')
    expect(facts.defaultBranchWorkflowFiles).toEqual([
      'agent-implement.yml',
      'test.yml'
    ])
  })

  it('reads the default branch from the API, not from this checkout', async () => {
    await probeSetup({ cwd, env: {} })
    const apiCall = calls
      .map((call) => call.join(' '))
      .find((call) => call.includes('/contents/'))
    expect(apiCall).toContain('repos/me/repo/contents/.github/workflows')
    expect(apiCall).toContain('ref=main')
  })

  it('carries the stated secret names through to the facts', async () => {
    const facts = await probeSetup({
      cwd,
      env: { REQUIRED_SECRETS: 'ONE,TWO', AGENT_PAT_SECRET: 'LOOP_PAT' }
    })
    expect(facts.requiredSecrets).toEqual(['ONE', 'TWO'])
    expect(facts.patSecret).toBe('LOOP_PAT')
  })

  it('follows a renamed PAT secret into what it requires', async () => {
    const facts = await probeSetup({
      cwd,
      env: { AGENT_PAT_SECRET: 'LOOP_PAT' }
    })
    expect(facts.requiredSecrets).toEqual([
      'CLAUDE_CODE_OAUTH_TOKEN',
      'LOOP_PAT'
    ])
  })

  it('passes a stated repo to gh rather than letting it infer one', async () => {
    await probeSetup({ cwd, env: { GITHUB_REPOSITORY: 'me/stated' } })
    const secretList = calls.find((call) => call[1] === 'secret')
    expect(secretList).toContain('--repo')
    expect(secretList).toContain('me/stated')
  })

  it('checks the workflow the caller pointed it at', async () => {
    writeCheckout({ 'elsewhere.yml': 'name: Elsewhere\non:\n  push:\n' })
    const facts = await probeSetup({
      cwd,
      env: { WORKFLOW_FILE: 'elsewhere.yml' }
    })
    expect(facts.workflowFile).toBe('elsewhere.yml')
    expect(facts.workflow).toContain('Elsewhere')
  })

  it('reports an unauthenticated gh apart from a gh it could not run', async () => {
    routeExecStub([
      {
        match: /^gh auth status/,
        response: {
          fails: 1,
          stderr: 'You are not logged into any GitHub hosts.'
        }
      }
    ])
    expect((await probeSetup({ cwd, env: {} })).ghAuth).toBe('unauthenticated')

    routeExecStub([{ match: /^gh auth status/, response: { fails: 'spawn' } }])
    expect((await probeSetup({ cwd, env: {} })).ghAuth).toBe('unknown')
  })

  it('degrades every unreadable probe to unknown rather than throwing', async () => {
    // Nothing installed and nothing on disk: every probe fails to spawn.
    routeExecStub([{ match: /./, response: { fails: 'spawn' } }])
    const facts = await probeSetup({ cwd: path.join(cwd, 'nowhere'), env: {} })
    expect(facts.ghAuth).toBe('unknown')
    expect(facts.ghTokenScopes).toBe('unknown')
    expect(facts.repoSecrets).toBe('unknown')
    expect(facts.repoLabels).toBe('unknown')
    expect(facts.defaultBranchWorkflowFiles).toBe('unknown')
    expect(facts.workflow).toBeNull()
    expect(facts.promptTemplate).toBeNull()
    expect(facts.runningCliVersion).toBeUndefined()

    // An entirely unreadable setup is unknown, not a pile of wrong bindings.
    expect(evaluateSetup(facts).ok).toBe(true)
  })

  it('writes nothing — no label is created, no secret set', async () => {
    await probeSetup({ cwd, env: { PROMPT_FILE: 'prompt.md' } })
    const written = calls.map((call) => call.join(' '))
    expect(
      written.some((call) => /label create|secret set|issue edit/.test(call))
    ).toBe(false)
    expect(fs.readdirSync(cwd).sort()).toEqual(['.github', 'prompt.md'])
  })

  it('feeds a verdict that names the bindings this checkout has wrong', async () => {
    const verdict = evaluateSetup(
      await probeSetup({ cwd, env: { PROMPT_FILE: 'prompt.md' } })
    )
    expect(verdict.ok).toBe(false)
    expect(verdict.failures.map((failure) => failure.id)).toEqual([
      'label-vocabulary',
      'prompt-tokens'
    ])
  })
})
