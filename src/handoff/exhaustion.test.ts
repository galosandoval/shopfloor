/**
 * The terminal state's decision, tested with nothing mocked: which issue gets a
 * comment, what the comment carries, and — the property that keeps a stateless
 * edge from becoming a comment generator — that it reports once.
 */

import { EXHAUSTED_LABEL } from '../issue-state/vocabulary'
import {
  buildExhaustionReport,
  EXHAUSTION_COMMENT_LIMIT,
  type ExhaustionReportInput
} from './exhaustion'

const attempt = (n: number, body = `attempt ${n} said this`) => ({
  path: `.agent/attempts/90${n}.md`,
  document: `# Attempt ${n} of 3\n\n${body}`
})

const baseInput: ExhaustionReportInput = {
  issueNumber: 50,
  repo: 'acme/widgets',
  branch: 'agent/issue-50',
  attempts: 3,
  maxAttempts: 3,
  currentLabels: ['agent:blocked', 'ready-for-human'],
  trail: [attempt(1), attempt(2), attempt(3)]
}

const commentFor = (input: ExhaustionReportInput): string => {
  const report = buildExhaustionReport(input)
  if (!report.report) throw new Error(`expected a report: ${report.reason}`)
  return report.comment
}

describe('buildExhaustionReport', () => {
  it('names the ceiling and says whose move it is', () => {
    const comment = commentFor(baseInput)

    expect(comment).toContain('3 of 3')
    expect(comment).toContain('#50')
    expect(comment).toMatch(/harder than the spec|spec is wrong/)
  })

  it('leaves the pull request open and the trail on the branch', () => {
    // Design §4: closing the PR discards partial work, and attempt N usually
    // got most of the way. Nothing here asks for either, and the comment says
    // so rather than leaving a human to guess what the harness did.
    const comment = commentFor(baseInput)

    expect(comment).toContain('nothing is closed')
    expect(comment).toContain('still committed on')
  })

  it('names the recovery that works, and rules out the one that does not', () => {
    // Re-labelling is the obvious guess and it cannot work: the count is the
    // issue's permanent timeline of `agent:in-progress` additions, so the next
    // event trips the same ceiling — silently, since this report has already
    // landed the label that stops it commenting twice.
    const comment = commentFor(baseInput)

    expect(comment).toContain('--max-attempts')
    expect(comment).toMatch(/not a re-label|will not do it/)
  })

  it('says how many attempts the comment actually carries', () => {
    const report = buildExhaustionReport(baseInput)

    expect(report).toMatchObject({ report: true, attemptsPosted: 3 })
  })

  it('carries every attempt document, oldest first', () => {
    const comment = commentFor(baseInput)

    expect(comment).toContain('attempt 1 said this')
    expect(comment).toContain('attempt 3 said this')
    expect(comment.indexOf('attempt 1 said this')).toBeLessThan(
      comment.indexOf('attempt 3 said this')
    )
  })

  it('reports nothing when the issue already carries the terminal label', () => {
    const report = buildExhaustionReport({
      ...baseInput,
      currentLabels: [EXHAUSTED_LABEL, 'ready-for-human']
    })

    expect(report.report).toBe(false)
    expect(report).toMatchObject({
      reason: expect.stringContaining(EXHAUSTED_LABEL)
    })
  })

  it('says the trail was empty rather than implying the attempts said nothing', () => {
    const comment = commentFor({ ...baseInput, trail: [] })

    expect(comment).toContain('No handoff documents were found')
  })

  it('says when part of the trail could not be read', () => {
    const comment = commentFor({
      ...baseInput,
      trail: [attempt(3)],
      trailUnavailable: 'could not read .agent/attempts/901.md (404)'
    })

    expect(comment).toContain('may not be every attempt')
    expect(comment).toContain('404')
  })

  describe('fitting one comment', () => {
    const long = (n: number) => attempt(n, 'x'.repeat(40_000))

    it('drops from the oldest end and says how many it dropped', () => {
      const comment = commentFor({
        ...baseInput,
        trail: [long(1), long(2), attempt(3)]
      })

      expect(comment.length).toBeLessThanOrEqual(EXHAUSTION_COMMENT_LIMIT)
      expect(comment).toContain('attempt 3 said this')
      expect(comment).toMatch(
        /oldest attempt(s)? (is|are) omitted|omitted to fit/
      )
      // What was posted, not what was read — a caller reporting the larger
      // number would say it posted evidence nobody can see.
      expect(
        buildExhaustionReport({
          ...baseInput,
          trail: [long(1), long(2), attempt(3)]
        })
      ).toMatchObject({ attemptsPosted: 2 })
    })

    it('keeps the newest attempt even when it alone overruns, cut and marked', () => {
      // It is the attempt the ceiling was reached on, so it is the last thing
      // to lose — and a silent cut would read as a document that ended there.
      const comment = commentFor({
        ...baseInput,
        trail: [attempt(1), { ...long(3), document: 'y'.repeat(80_000) }]
      })

      expect(comment.length).toBeLessThanOrEqual(EXHAUSTION_COMMENT_LIMIT)
      expect(comment).toContain('truncated')
      expect(comment).toContain('.agent/attempts/903.md')
    })
  })
})
