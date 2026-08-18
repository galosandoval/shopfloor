import { agentBranchForIssue, issueNumberFromBranch } from './branch'

describe('agentBranchForIssue', () => {
  it('names the branch after the issue and nothing else', () => {
    expect(agentBranchForIssue(46)).toBe('agent/issue-46')
  })

  it('round-trips through the parser', () => {
    expect(issueNumberFromBranch(agentBranchForIssue(1234))).toBe(1234)
  })
})

describe('issueNumberFromBranch', () => {
  it('accepts a slug appended by a human or by older glue', () => {
    expect(issueNumberFromBranch('agent/issue-46-classify-trigger')).toBe(46)
  })

  it('tolerates surrounding whitespace, which is how a probe returns it', () => {
    expect(issueNumberFromBranch('  agent/issue-46\n')).toBe(46)
  })

  it.each([
    ['development', 'a human branch'],
    ['agent/issue-', 'the prefix with no number'],
    ['agent/issue-46x', 'a suffix that is not a slug'],
    ['agent/issue-0', 'issue zero, which does not exist'],
    ['feature/agent/issue-46', 'the prefix somewhere other than the start'],
    ['agent/issue-9007199254740993', 'a number past what JSON can carry']
  ])('does not claim %s (%s)', (branch) => {
    expect(issueNumberFromBranch(branch)).toBeUndefined()
  })
})
