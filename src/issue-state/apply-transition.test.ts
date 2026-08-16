/**
 * Wiring for the state machine's `gh` half: that the transition's edits reach
 * `gh issue edit`, that a no-op delta spends no write, and that an unstated
 * label set is read rather than assumed. The transition itself is tested pure
 * in `transition.test.ts` — re-asserting it here would prove nothing about
 * whether the shell calls it.
 */

import {
  calls,
  execStubModule,
  resetExecStub,
  respondWith
} from '../process/exec-stub.test-helper'
import { applyLabelTransition } from './apply-transition'

vi.mock('node:child_process', () => execStubModule())

beforeEach(() => {
  resetExecStub({ stdout: '' })
})

describe('applyLabelTransition', () => {
  it('writes both edits in one `gh issue edit`', async () => {
    const { applied } = await applyLabelTransition({
      issueNumber: '45',
      repo: 'acme/widgets',
      outcome: 'refused',
      currentLabels: ['ready-for-agent', 'agent:implement']
    })

    expect(applied).toBe(true)
    expect(calls).toEqual([
      [
        'gh',
        'issue',
        'edit',
        '45',
        '--repo',
        'acme/widgets',
        '--remove-label',
        'ready-for-agent',
        '--remove-label',
        'agent:implement',
        '--add-label',
        'agent:blocked',
        '--add-label',
        'ready-for-human'
      ]
    ])
  })

  it('writes nothing when the issue is already in the target state', async () => {
    const { applied, transition } = await applyLabelTransition({
      issueNumber: '45',
      repo: 'acme/widgets',
      outcome: 'succeeded',
      currentLabels: ['ready-for-human']
    })

    expect(applied).toBe(false)
    expect(transition).toEqual({ outcome: 'succeeded', add: [], remove: [] })
    expect(calls).toEqual([])
  })

  it('reads the issue when no labels were stated', async () => {
    respondWith({ stdout: 'ready-for-agent\nbug\n' })

    const { transition } = await applyLabelTransition({
      issueNumber: '45',
      repo: 'acme/widgets',
      outcome: 'started'
    })

    expect(calls[0]).toEqual([
      'gh',
      'issue',
      'view',
      '45',
      '--repo',
      'acme/widgets',
      '--json',
      'labels',
      '-q',
      '.labels[].name'
    ])
    // `bug` is the consumer's, and survives untouched.
    expect(transition.remove).toEqual(['ready-for-agent'])
    expect(transition.add).toEqual(['agent:implement', 'agent:in-progress'])
  })

  it('lets a failed `gh` surface rather than swallowing it', async () => {
    respondWith({ fails: 1, stderr: 'label not found' })

    await expect(
      applyLabelTransition({
        issueNumber: '45',
        repo: 'acme/widgets',
        outcome: 'succeeded',
        currentLabels: ['agent:in-progress']
      })
    ).rejects.toThrow()
  })
})
