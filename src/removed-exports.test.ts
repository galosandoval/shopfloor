/**
 * The export shims (shopfloor#51), asserted through the public surface rather
 * than the module that defines them — the whole point is that a consumer
 * reaching for the old name off `@galosandoval/shopfloor` finds something, and
 * that what they find says why.
 */

import {
  runImplementAgent,
  runPreflight,
  postVerifyComment,
  runPluginDirsCheck
} from './index'

const REMOVED = [
  ['runImplementAgent', runImplementAgent, 'resolveImplementConfig'],
  ['runPreflight', runPreflight, 'evaluatePreflight'],
  ['postVerifyComment', postVerifyComment, 'buildVerifyComment'],
  ['runPluginDirsCheck', runPluginDirsCheck, 'evaluatePluginDirs']
] as const

describe('the verbs the surface stopped exporting', () => {
  it.each(REMOVED)('%s is still there to be called', (name, verb) => {
    expect(typeof verb).toBe('function')
    expect(verb).not.toBeUndefined()
    expect(name).toBeTruthy()
  })

  it.each(REMOVED)('%s throws, naming itself and the verb', (name, verb) => {
    expect(verb).toThrow(new RegExp(`\`${name}\` was removed`))
    expect(verb).toThrow(/runPhase/)
  })

  /**
   * The pure half of each pair still ships, and is what a caller reaching for
   * the shell usually wanted. A refusal that only says "gone" sends them to the
   * changelog; this one sends them to the function.
   */
  it.each(REMOVED)(
    '%s names the half that still ships',
    (_name, verb, pure) => {
      expect(verb).toThrow(new RegExp(pure))
    }
  )
})
