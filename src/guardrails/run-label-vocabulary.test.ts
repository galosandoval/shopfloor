/**
 * Wiring for the label-vocabulary shell: that the probe asks the right
 * repository and that what `gh` answers — including answering nothing —
 * reaches the verdict. The refusal logic is tested pure in
 * `label-vocabulary.test.ts`.
 */

import {
  calls,
  execStubModule,
  resetExecStub,
  respondWith
} from '../process/exec-stub.test-helper'
import { REQUIRED_LABELS } from '../issue-state/vocabulary'
import { runLabelVocabularyCheck } from './run-label-vocabulary'

vi.mock('node:child_process', () => execStubModule())

beforeEach(() => {
  resetExecStub({ stdout: REQUIRED_LABELS.join('\n') })
})

describe('runLabelVocabularyCheck', () => {
  it('lists the stated repository’s labels', async () => {
    const verdict = await runLabelVocabularyCheck({
      repo: 'acme/widgets',
      cwd: '/repo'
    })

    expect(calls).toEqual([
      [
        'gh',
        'label',
        'list',
        '--repo',
        'acme/widgets',
        '--limit',
        '200',
        '--json',
        'name',
        '-q',
        '.[].name'
      ]
    ])
    expect(verdict).toEqual({ refused: false })
  })

  it('lets `gh` infer the repository when none was stated', async () => {
    await runLabelVocabularyCheck({ repo: undefined, cwd: '/repo' })

    expect(calls[0]).not.toContain('--repo')
  })

  it('refuses naming the label the repository lacks', async () => {
    respondWith({
      stdout: REQUIRED_LABELS.filter((l) => l !== 'ready-for-human').join('\n')
    })

    const verdict = await runLabelVocabularyCheck({
      repo: 'acme/widgets',
      cwd: '/repo'
    })

    expect(verdict.refused).toBe(true)
    if (!verdict.refused) return
    expect(verdict.missing).toEqual(['ready-for-human'])
  })

  it('turns an unreadable `gh` into unknown, not into an empty repository', async () => {
    respondWith({ fails: 'spawn' })

    const verdict = await runLabelVocabularyCheck({
      repo: 'acme/widgets',
      cwd: '/repo'
    })

    expect(verdict.refused).toBe(true)
    if (!verdict.refused) return
    expect(verdict.missing).toEqual([])
    expect(verdict.reason).toContain('could not be read')
  })
})
