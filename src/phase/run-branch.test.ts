/**
 * Wiring for the branch shell: that a retrigger reuses the branch it finds
 * rather than making a second one, and that the name it uses is the one
 * `agentBranchForIssue` writes down.
 */

import {
  calls,
  execStubModule,
  resetExecStub,
  routeExecStub
} from '../process/exec-stub.test-helper'
import { agentBranchForIssue } from '../trigger/branch'
import { ensureAgentBranch, pushAgentBranch } from './run-branch'

vi.mock('node:child_process', () => execStubModule())

beforeEach(() => {
  resetExecStub({ stdout: '' })
})

const ran = (fragment: string) =>
  calls.some((call) => call.join(' ').includes(fragment))

describe('ensureAgentBranch', () => {
  it('reuses the remote branch a retrigger lands on', async () => {
    routeExecStub([
      { match: /ls-remote/, response: { stdout: 'abc123\trefs/heads/x\n' } }
    ])

    const result = await ensureAgentBranch({ issueNumber: 47, cwd: '/repo' })

    expect(result).toEqual({ branch: agentBranchForIssue(47), created: false })
    expect(ran(`fetch origin ${agentBranchForIssue(47)}`)).toBe(true)
    expect(ran(`checkout -B ${agentBranchForIssue(47)} FETCH_HEAD`)).toBe(true)
    expect(ran('checkout -b')).toBe(false)
  })

  it('checks out a local branch of the same name rather than recreating it', async () => {
    routeExecStub([
      { match: /ls-remote/, response: { stdout: '' } },
      { match: /rev-parse --verify/, response: { stdout: 'abc123\n' } }
    ])

    const result = await ensureAgentBranch({ issueNumber: 47, cwd: '/repo' })

    expect(result.created).toBe(false)
    expect(ran(`checkout ${agentBranchForIssue(47)}`)).toBe(true)
    expect(ran('checkout -b')).toBe(false)
  })

  it('creates the branch when nothing has it yet', async () => {
    routeExecStub([
      { match: /ls-remote/, response: { stdout: '' } },
      { match: /rev-parse --verify/, response: { fails: 1 } }
    ])

    const result = await ensureAgentBranch({ issueNumber: 47, cwd: '/repo' })

    expect(result).toEqual({ branch: agentBranchForIssue(47), created: true })
    expect(ran(`checkout -b ${agentBranchForIssue(47)}`)).toBe(true)
  })
})

describe('pushAgentBranch', () => {
  it('pushes without forcing — the rule the run guards the agent with', async () => {
    await pushAgentBranch({ branch: 'agent/issue-47', cwd: '/repo' })

    expect(calls).toEqual([
      ['git', 'push', '--set-upstream', 'origin', 'agent/issue-47']
    ])
  })
})
