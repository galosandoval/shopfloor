/**
 * Wiring for the PR shell: that a retrigger finds the PR already open and
 * spends no `gh pr create` on it, and that a first run opens a draft carrying
 * the body the pure builder wrote.
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
import { ensurePullRequest } from './run-pull-request'

vi.mock('node:child_process', () => execStubModule())

let workDir: string

beforeEach(() => {
  resetExecStub({ stdout: '' })
  workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'shopfloor-pr-'))
})

const input = () => ({
  issueNumber: 47,
  issueTitle: 'One verb',
  repo: 'acme/widgets',
  branch: 'agent/issue-47',
  prDescriptionFile: path.join(workDir, 'pr_description.txt'),
  cwd: workDir,
  bodyFile: path.join(workDir, 'body.md')
})

describe('ensurePullRequest', () => {
  it('reuses the PR a retrigger already has open', async () => {
    routeExecStub([
      { match: /pr list/, response: { stdout: '12\thttps://x/pull/12\n' } }
    ])

    const result = await ensurePullRequest(input())

    expect(result).toEqual({
      number: '12',
      url: 'https://x/pull/12',
      created: false
    })
    expect(calls.some((call) => call.includes('create'))).toBe(false)
  })

  it('opens a draft PR carrying the agent description and the closing keyword', async () => {
    fs.writeFileSync(input().prDescriptionFile, 'Adds the verb.\n')
    routeExecStub([
      { match: /pr list/, response: { stdout: '' } },
      {
        match: /pr create/,
        response: { stdout: 'https://github.com/acme/widgets/pull/13\n' }
      }
    ])

    const result = await ensurePullRequest(input())

    expect(result).toEqual({
      number: '13',
      url: 'https://github.com/acme/widgets/pull/13',
      created: true
    })

    const create = calls.find((call) => call.includes('create')) ?? []
    expect(create).toContain('--draft')
    expect(create).toContain('One verb (#47)')
    expect(fs.readFileSync(input().bodyFile, 'utf8')).toBe(
      'Adds the verb.\n\nCloses #47\n'
    )
  })

  it('still opens the PR when the agent wrote no description', async () => {
    routeExecStub([
      { match: /pr list/, response: { stdout: '' } },
      { match: /pr create/, response: { stdout: 'https://x/pull/14\n' } }
    ])

    await ensurePullRequest(input())

    expect(fs.readFileSync(input().bodyFile, 'utf8')).toBe('Closes #47\n')
  })
})
