/**
 * The transition table, tested as what it is: a total function over the
 * outcomes the harness can produce. No IO — `apply-transition.test.ts` covers
 * the `gh` half, and neither test can stand in for the other.
 */

import {
  evaluateLabelTransition,
  RUN_OUTCOMES,
  TRANSITION_TABLE
} from './transition'
import { REQUIRED_LABELS } from './vocabulary'

describe('TRANSITION_TABLE', () => {
  it('is exhaustive over the outcomes rather than defaulting', () => {
    for (const outcome of RUN_OUTCOMES) {
      expect(TRANSITION_TABLE[outcome]).toBeDefined()
    }
    expect(Object.keys(TRANSITION_TABLE).sort()).toEqual(
      [...RUN_OUTCOMES].sort()
    )
  })

  it('names only labels the package owns', () => {
    for (const outcome of RUN_OUTCOMES) {
      for (const label of TRANSITION_TABLE[outcome].target) {
        expect(REQUIRED_LABELS).toContain(label)
      }
    }
  })

  it('sets ready-for-human on every terminal outcome and on no other', () => {
    for (const outcome of RUN_OUTCOMES) {
      const target = TRANSITION_TABLE[outcome].target
      expect(target.includes('ready-for-human')).toBe(outcome !== 'started')
    }
  })
})

describe('evaluateLabelTransition', () => {
  it('takes a labeled issue into the in-flight state when a run starts', () => {
    expect(
      evaluateLabelTransition({
        currentLabels: ['ready-for-agent', 'agent:implement'],
        outcome: 'started'
      })
    ).toEqual({
      outcome: 'started',
      add: ['agent:in-progress'],
      remove: ['ready-for-agent']
    })
  })

  it('hands a finished run back to a human', () => {
    expect(
      evaluateLabelTransition({
        currentLabels: [
          'ready-for-agent',
          'agent:implement',
          'agent:in-progress'
        ],
        outcome: 'succeeded'
      })
    ).toEqual({
      outcome: 'succeeded',
      add: ['ready-for-human'],
      remove: ['ready-for-agent', 'agent:implement', 'agent:in-progress']
    })
  })

  it('blocks a refused run and hands it back', () => {
    expect(
      evaluateLabelTransition({
        currentLabels: ['ready-for-agent', 'agent:implement'],
        outcome: 'refused'
      })
    ).toEqual({
      outcome: 'refused',
      add: ['agent:blocked', 'ready-for-human'],
      remove: ['ready-for-agent', 'agent:implement']
    })
  })

  it('keeps an exhausted run distinct from a blocked one', () => {
    const exhausted = evaluateLabelTransition({
      currentLabels: ['agent:implement', 'agent:in-progress'],
      outcome: 'exhausted'
    })
    const failed = evaluateLabelTransition({
      currentLabels: ['agent:implement', 'agent:in-progress'],
      outcome: 'failed'
    })

    expect(exhausted.add).toContain('agent:exhausted')
    expect(exhausted.add).not.toContain('agent:blocked')
    expect(failed.add).toContain('agent:blocked')
    expect(failed.add).not.toContain('agent:exhausted')
  })

  it('never touches a label outside the vocabulary', () => {
    const { add, remove } = evaluateLabelTransition({
      currentLabels: ['bug', 'good first issue', 'agent:implement'],
      outcome: 'succeeded'
    })

    expect(remove).toEqual(['agent:implement'])
    expect(add).toEqual(['ready-for-human'])
  })

  it('asks for nothing when the issue is already in the target state', () => {
    expect(
      evaluateLabelTransition({
        currentLabels: ['ready-for-human', 'bug'],
        outcome: 'succeeded'
      })
    ).toEqual({ outcome: 'succeeded', add: [], remove: [] })
  })

  it('is total over every outcome from an empty label set', () => {
    for (const outcome of RUN_OUTCOMES) {
      const transition = evaluateLabelTransition({
        currentLabels: [],
        outcome
      })
      expect(transition.remove).toEqual([])
      expect(transition.add).toEqual([...TRANSITION_TABLE[outcome].target])
    }
  })
})
