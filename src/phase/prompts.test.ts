import { PROMPT_TOKENS } from '../setup/setup'
import { evaluatePromptReadiness } from '../guardrails/prompt-readiness'
import { PHASES, type Phase } from '../trigger/classify'
import { DEFAULT_PHASE_PROMPTS, resolvePhasePrompt } from './prompts'

describe('DEFAULT_PHASE_PROMPTS', () => {
  it('ships a prompt for every phase the loop can discover', () => {
    for (const phase of PHASES) {
      expect(DEFAULT_PHASE_PROMPTS[phase].trim()).not.toBe('')
    }
  })

  it('would not be refused by the readiness check every run makes', () => {
    for (const phase of PHASES) {
      expect(
        evaluatePromptReadiness({
          prompt: DEFAULT_PHASE_PROMPTS[phase],
          knownTokens: PROMPT_TOKENS
        })
      ).toEqual({ refused: false })
    }
  })

  it('carries no environment content — no install, no gate command', () => {
    for (const phase of PHASES) {
      const prompt = DEFAULT_PHASE_PROMPTS[phase].toLowerCase()
      for (const environment of [
        'bun install',
        'npm ci',
        'pnpm install',
        'yarn install',
        'npm run test',
        'prisma'
      ]) {
        expect(prompt).not.toContain(environment)
      }
    }
  })
})

describe('resolvePhasePrompt', () => {
  it('falls back to the shipped shim when nothing was stated', () => {
    expect(resolvePhasePrompt({ phase: 'implement' })).toEqual({
      resolved: true,
      prompt: DEFAULT_PHASE_PROMPTS.implement
    })
  })

  it("prefers the caller's own prompt for that phase", () => {
    expect(
      resolvePhasePrompt({
        phase: 'implement',
        stated: { implement: 'do the thing' }
      })
    ).toEqual({ resolved: true, prompt: 'do the thing' })
  })

  it('refuses a stated prompt that is empty, naming the phase', () => {
    const verdict = resolvePhasePrompt({
      phase: 'implement',
      stated: { implement: '   ' }
    })

    expect(verdict.resolved).toBe(false)
    expect(verdict.resolved === false && verdict.reason).toContain('implement')
  })

  it('refuses a phase nothing ships or states a prompt for', () => {
    const verdict = resolvePhasePrompt({ phase: 'review' as Phase })

    expect(verdict.resolved).toBe(false)
    expect(verdict.resolved === false && verdict.reason).toContain('review')
  })
})
