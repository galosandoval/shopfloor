import { buildVerifyComment } from './verify-comment'

describe('buildVerifyComment', () => {
  const base = {
    report: 'Verified the recipes flow.',
    repo: 'galosandoval/shopfloor',
    ref: 'abc1234',
    runUrl: 'https://github.com/galosandoval/shopfloor/actions/runs/1'
  }

  it('renders each screenshot inline with a raw URL', () => {
    const body = buildVerifyComment({
      ...base,
      screenshots: ['.agent/verify/issue-5/recipes.png']
    })
    expect(body).toContain('Verified the recipes flow.')
    expect(body).toContain(
      '![recipes.png](https://raw.githubusercontent.com/galosandoval/shopfloor/abc1234/.agent/verify/issue-5/recipes.png)'
    )
    expect(body).toContain('### Screenshots')
    expect(body).toContain('[View the workflow run](')
  })

  it('percent-encodes ref and filename segments but keeps slashes', () => {
    const body = buildVerifyComment({
      ...base,
      ref: 'refs/heads/agent/issue-5',
      screenshots: ['.agent/verify/issue-5/final state.png']
    })
    expect(body).toContain(
      '![final state.png](https://raw.githubusercontent.com/galosandoval/shopfloor/refs/heads/agent/issue-5/.agent/verify/issue-5/final%20state.png)'
    )
  })

  it('omits the screenshots section when there are none (non-UI / skipped)', () => {
    const body = buildVerifyComment({ ...base, screenshots: [] })
    expect(body).toContain('Verified the recipes flow.')
    expect(body).not.toContain('### Screenshots')
    expect(body).toContain('[View the workflow run](')
  })

  it('falls back to a placeholder when the report is empty', () => {
    const body = buildVerifyComment({ ...base, report: '   ', screenshots: [] })
    expect(body).toContain('_No verify report was produced._')
  })
})
