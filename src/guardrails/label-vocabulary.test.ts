import { REQUIRED_LABELS } from '../issue-state/vocabulary'
import { evaluateLabelVocabulary } from './label-vocabulary'

describe('evaluateLabelVocabulary', () => {
  it('admits a repository carrying the whole vocabulary', () => {
    expect(
      evaluateLabelVocabulary({ repoLabels: [...REQUIRED_LABELS] })
    ).toEqual({ refused: false })
  })

  it('ignores the consumer’s own labels', () => {
    expect(
      evaluateLabelVocabulary({
        repoLabels: [...REQUIRED_LABELS, 'bug', 'good first issue']
      })
    ).toEqual({ refused: false })
  })

  it('names every missing label rather than the first', () => {
    const verdict = evaluateLabelVocabulary({
      repoLabels: REQUIRED_LABELS.filter(
        (label) => label !== 'ready-for-human' && label !== 'agent:exhausted'
      )
    })

    expect(verdict.refused).toBe(true)
    if (!verdict.refused) return
    expect(verdict.missing).toEqual(['ready-for-human', 'agent:exhausted'])
    expect(verdict.reason).toContain('ready-for-human')
    expect(verdict.reason).toContain('agent:exhausted')
    expect(verdict.reason).toContain('shopfloor init')
  })

  it('refuses an unreadable probe, and says so rather than naming labels', () => {
    const verdict = evaluateLabelVocabulary({ repoLabels: 'unknown' })

    expect(verdict.refused).toBe(true)
    if (!verdict.refused) return
    // Unreadable is not missing: `gh` being unauthenticated and a repository
    // being unconfigured are different things to go fix.
    expect(verdict.missing).toEqual([])
    expect(verdict.reason).toContain('could not be read')
  })

  it('refuses a repository with no labels at all', () => {
    const verdict = evaluateLabelVocabulary({ repoLabels: [] })

    expect(verdict.refused).toBe(true)
    if (!verdict.refused) return
    expect(verdict.missing).toEqual([...REQUIRED_LABELS])
  })
})
