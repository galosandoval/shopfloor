import { parseClosingReferences } from '../guardrails/preflight'
import { buildPullRequestFields } from './pull-request'

describe('buildPullRequestFields', () => {
  const base = { issueNumber: 47, issueTitle: 'One verb' }

  it('names the PR after the issue', () => {
    expect(buildPullRequestFields({ ...base, description: 'x' }).title).toBe(
      'One verb (#47)'
    )
  })

  it("keeps the agent's description and closes the issue", () => {
    const { body } = buildPullRequestFields({
      ...base,
      description: 'Adds the verb.'
    })

    expect(body).toBe('Adds the verb.\n\nCloses #47\n')
  })

  it('closes the issue exactly once when the description already does', () => {
    const { body } = buildPullRequestFields({
      ...base,
      description: 'Adds the verb.\n\nCloses #47'
    })

    expect(parseClosingReferences(body)).toEqual([47])
  })

  it('still closes the issue when the agent wrote nothing', () => {
    expect(buildPullRequestFields({ ...base, description: '   \n' }).body).toBe(
      'Closes #47\n'
    )
  })

  it('is not fooled by a closing reference to a different issue', () => {
    const { body } = buildPullRequestFields({
      ...base,
      description: 'Closes #12'
    })

    expect(parseClosingReferences(body)).toEqual([12, 47])
  })
})
