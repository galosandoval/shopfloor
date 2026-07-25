import {
  evaluatePreflight,
  parseClosingReferences,
  type PreflightInput
} from './preflight'

const baseInput: PreflightInput = {
  subIssueCount: 0,
  parentNumber: null,
  linkingPullRequests: []
}

describe('parseClosingReferences', () => {
  it('extracts the issue number from each GitHub closing keyword', () => {
    expect(parseClosingReferences('Closes #12')).toEqual([12])
    expect(parseClosingReferences('closed #7')).toEqual([7])
    expect(parseClosingReferences('Fixes #3')).toEqual([3])
    expect(parseClosingReferences('fixed #8.')).toEqual([8])
    expect(parseClosingReferences('Resolves #4')).toEqual([4])
    expect(parseClosingReferences('resolve #5')).toEqual([5])
  })

  it('is case-insensitive and accepts an optional colon', () => {
    expect(parseClosingReferences('CLOSES #9')).toEqual([9])
    expect(parseClosingReferences('Closes: #6')).toEqual([6])
  })

  it('collects every reference and de-duplicates', () => {
    expect(
      parseClosingReferences('fixes #3 and resolves #4\n\nCloses #3')
    ).toEqual([3, 4])
  })

  it('ignores non-closing references and bare numbers', () => {
    expect(parseClosingReferences('Relates to #5')).toEqual([])
    expect(parseClosingReferences('Refs #5, see #6')).toEqual([])
    expect(parseClosingReferences('part of a prefix#5 word')).toEqual([])
    expect(parseClosingReferences('')).toEqual([])
  })
})

describe('evaluatePreflight', () => {
  it('passes a leaf issue with no parent and no open PR', () => {
    expect(evaluatePreflight(baseInput)).toEqual({ refused: false })
  })

  it('refuses a PRD (issue with native sub-issues)', () => {
    const verdict = evaluatePreflight({ ...baseInput, subIssueCount: 4 })
    expect(verdict.refused).toBe(true)
    if (verdict.refused) {
      expect(verdict.reason).toMatch(/PRD/)
      expect(verdict.reason).toContain('4')
    }
  })

  it('refuses an issue that is a native sub-issue of a parent', () => {
    const verdict = evaluatePreflight({ ...baseInput, parentNumber: 507 })
    expect(verdict.refused).toBe(true)
    if (verdict.refused) {
      expect(verdict.reason).toContain('#507')
    }
  })

  it('refuses an issue that already has an open PR targeting it', () => {
    const verdict = evaluatePreflight({
      ...baseInput,
      linkingPullRequests: [{ number: 42, url: 'https://example/pr/42' }]
    })
    expect(verdict.refused).toBe(true)
    if (verdict.refused) {
      expect(verdict.reason).toContain('#42')
    }
  })

  it('reports the PRD refusal before any other (it is the most specific)', () => {
    const verdict = evaluatePreflight({
      subIssueCount: 2,
      parentNumber: 507,
      linkingPullRequests: [{ number: 42, url: 'https://example/pr/42' }]
    })
    expect(verdict.refused).toBe(true)
    if (verdict.refused) {
      expect(verdict.reason).toMatch(/PRD/)
    }
  })
})
