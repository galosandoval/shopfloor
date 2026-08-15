/**
 * The verdict itself, over prompt text and a token table — no IO, nothing
 * stubbed. That a run actually asks for this verdict before spawning is a
 * separate test, in `implement.test.ts`.
 */

import { evaluatePromptReadiness } from './prompt-readiness'
import { ENVIRONMENT_UNFILLED_SENTINEL, PROMPT_TOKENS } from '../setup/setup'

function verdict(prompt: string) {
  return evaluatePromptReadiness({ prompt, knownTokens: PROMPT_TOKENS })
}

/** The reason of a refusal, or a failure naming what came back instead. */
function reasonOf(prompt: string): string {
  const result = verdict(prompt)
  if (!result.refused) throw new Error(`expected a refusal for: ${prompt}`)
  return result.reason
}

const FILLED = [
  'Implement issue {{ISSUE_NUMBER}}: {{ISSUE_TITLE}} on {{BRANCH}}.',
  'Write the PR description to {{PR_DESCRIPTION_FILE}}, the verify report to',
  '{{VERIFY_REPORT_FILE}}, and screenshots to {{SCREENSHOTS_DIR}}.',
  'Run `npm run typecheck` and `npm test` before you commit.'
].join('\n')

describe('evaluatePromptReadiness', () => {
  it('admits a prompt whose tokens are all substituted ones', () => {
    expect(verdict(FILLED)).toEqual({ refused: false })
  })

  it('admits a prompt carrying no tokens at all', () => {
    // Missing tokens are the doctor's business — this guard refuses what a run
    // cannot render, not what a consumer chose to leave out.
    expect(verdict('Implement the issue. Run the tests.')).toEqual({
      refused: false
    })
  })

  it('refuses a prompt still carrying the scaffolder’s sentinel', () => {
    const scaffolded = `${FILLED}\n${ENVIRONMENT_UNFILLED_SENTINEL}: name this repo's gate command.`

    expect(reasonOf(scaffolded)).toContain(ENVIRONMENT_UNFILLED_SENTINEL)
  })

  it('names every line the sentinel is on', () => {
    const reason = reasonOf(
      [
        `${ENVIRONMENT_UNFILLED_SENTINEL}: the package manager.`,
        'Implement issue {{ISSUE_NUMBER}}.',
        `${ENVIRONMENT_UNFILLED_SENTINEL}: the gate command.`
      ].join('\n')
    )

    expect(reason).toMatch(/lines 1, 3/)
  })

  it('refuses an unrendered token that nothing substitutes, naming it', () => {
    const reason = reasonOf(`${FILLED}\nStandards live in {{STANDARDS_DIR}}.`)

    expect(reason).toContain('{{STANDARDS_DIR}}')
  })

  it('names every unrecognized token, once each', () => {
    const reason = reasonOf(
      'Use {{STANDARDS_DIR}} and {{ISSUE_NUMBR}}, then {{STANDARDS_DIR}} again.'
    )

    expect(reason).toContain('{{ISSUE_NUMBR}}')
    expect(reason.match(/\{\{STANDARDS_DIR\}\}/g)).toHaveLength(1)
  })

  it('refuses a spaced token, which substitution renders no more than a misspelt one', () => {
    // The doctor's own token check tolerates the spaces; the renderer does
    // not, so this reaches the agent as literal text exactly like {{FOO}}.
    expect(reasonOf('Implement issue {{ ISSUE_NUMBER }}.')).toContain(
      '{{ ISSUE_NUMBER }}'
    )
  })

  it('refuses a token whose case is wrong', () => {
    expect(reasonOf('Implement issue {{issue_number}}.')).toContain(
      '{{issue_number}}'
    )
  })

  it('leaves braced prose alone — a token is identifier-shaped', () => {
    expect(verdict('Answer in the form {{ one or two sentences }}.')).toEqual({
      refused: false
    })
  })

  it('names what should replace an unrecognized token', () => {
    const reason = reasonOf('Standards live in {{STANDARDS_DIR}}.')

    for (const token of PROMPT_TOKENS) {
      expect(reason).toContain(`{{${token}}}`)
    }
  })

  it('reports both failures at once rather than one at a time', () => {
    const reason = reasonOf(
      `${ENVIRONMENT_UNFILLED_SENTINEL}: the gate command.\n{{STANDARDS_DIR}}`
    )

    expect(reason).toContain(ENVIRONMENT_UNFILLED_SENTINEL)
    expect(reason).toContain('{{STANDARDS_DIR}}')
  })

  it('judges against the table it is given, not a baked-in one', () => {
    expect(
      evaluatePromptReadiness({
        prompt: 'A {{CUSTOM_TOKEN}} some caller substitutes.',
        knownTokens: ['CUSTOM_TOKEN']
      })
    ).toEqual({ refused: false })
  })
})
