import { evaluatePhaseOutcome } from './outcome'

describe('evaluatePhaseOutcome', () => {
  it('sends a finished run to the succeeded row', () => {
    expect(evaluatePhaseOutcome({ failed: false })).toBe('succeeded')
  })

  it('keeps a spent ceiling apart from a crash', () => {
    expect(evaluatePhaseOutcome({ failed: true, exhausted: true })).toBe(
      'exhausted'
    )
    expect(evaluatePhaseOutcome({ failed: true, exhausted: false })).toBe(
      'failed'
    )
  })
})
