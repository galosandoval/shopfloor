/**
 * The refusal shims (shopfloor#51), asserted where they are decided: a table of
 * stated fields and environment variables in, a verdict out, nothing mocked.
 *
 * What the tables *contain* is asserted too, and deliberately — a shim that
 * quietly loses an entry is indistinguishable from the silent removal the whole
 * mechanism exists to prevent.
 */

import {
  evaluateRemovedInputs,
  PAYLOAD_OWNED_INPUTS,
  REMOVED_RUN_CONFIG_INPUTS
} from './removed-inputs'

const removed = PAYLOAD_OWNED_INPUTS

describe('evaluateRemovedInputs', () => {
  it('admits a caller that states none of them', () => {
    expect(
      evaluateRemovedInputs({
        stated: { pluginDirs: ['/tmp/plugin'], maxAttempts: 3 },
        env: { GITHUB_REPOSITORY: 'acme/widgets', PROMPT_FILE: 'p.md' },
        removed
      })
    ).toEqual({ refused: false })
  })

  it('refuses a stated field, naming it and what replaced it', () => {
    const verdict = evaluateRemovedInputs({
      stated: { issueNumber: '51' },
      env: {},
      removed
    })

    expect(verdict.refused).toBe(true)
    expect(verdict.refused && verdict.reason).toContain('`issueNumber`')
    expect(verdict.refused && verdict.reason).toContain('GITHUB_EVENT_PATH')
  })

  it('refuses a set environment variable with nothing stated', () => {
    const verdict = evaluateRemovedInputs({
      env: { BRANCH: 'agent/issue-51' },
      removed
    })

    expect(verdict.refused && verdict.reason).toContain('BRANCH')
    expect(verdict.refused && verdict.reason).toContain('agent/issue-<n>')
  })

  it('names every one it found rather than the first', () => {
    const verdict = evaluateRemovedInputs({
      stated: { promptTemplate: '# implement', repo: 'acme/widgets' },
      env: { ISSUE_NUMBER: '51' },
      removed
    })

    const reason = verdict.refused ? verdict.reason : ''
    expect(reason).toContain('3 inputs')
    expect(reason).toContain('`promptTemplate`')
    expect(reason).toContain('`repo`')
    expect(reason).toContain('`issueNumber`')
  })

  it('lets an emptied value through — unsetting is what migrating looks like', () => {
    expect(
      evaluateRemovedInputs({
        stated: { branch: '' },
        env: { ISSUE_NUMBER: '', STANDARDS_DIR: '' },
        removed
      })
    ).toEqual({ refused: false })
  })

  it('checks only the table it was handed', () => {
    expect(
      evaluateRemovedInputs({
        stated: { standardsDir: '/repo/standards' },
        env: {},
        removed
      })
    ).toEqual({ refused: false })

    expect(
      evaluateRemovedInputs({
        stated: { standardsDir: '/repo/standards' },
        env: {},
        removed: REMOVED_RUN_CONFIG_INPUTS
      }).refused
    ).toBe(true)
  })

  it('refuses STANDARDS_DIR from the environment alone, as it has since #27', () => {
    const verdict = evaluateRemovedInputs({
      env: { STANDARDS_DIR: '/repo/standards' },
      removed: REMOVED_RUN_CONFIG_INPUTS
    })

    expect(verdict.refused && verdict.reason).toContain('`standardsDir`')
    expect(verdict.refused && verdict.reason).toContain('pluginDirs')
  })
})

describe('the tables themselves', () => {
  it('covers every input the payload took over', () => {
    expect(PAYLOAD_OWNED_INPUTS.map((entry) => entry.field)).toEqual([
      'issueNumber',
      'issueTitle',
      'branch',
      'repo',
      'promptTemplate'
    ])
  })

  it('names no variable the runner sets for every job', () => {
    const vars = PAYLOAD_OWNED_INPUTS.map((entry) => entry.envVar)

    expect(vars).not.toContain('GITHUB_REPOSITORY')
    expect(vars).not.toContain('GITHUB_REF_NAME')
    expect(vars).not.toContain('PROMPT_FILE')
  })

  /**
   * Every entry is reachable and self-describing — the property the table is
   * for. A field with a name nothing states, or a variable spelled differently
   * from the one a consumer's CI exports, is a shim that is present, plausible,
   * and silent, which is the failure it exists to prevent.
   */
  it('refuses on every entry it lists, naming that entry and its replacement', () => {
    const removed = [...PAYLOAD_OWNED_INPUTS, ...REMOVED_RUN_CONFIG_INPUTS]

    for (const entry of removed) {
      const hit = evaluateRemovedInputs({
        ...(entry.field ? { stated: { [entry.field]: 'stated' } } : {}),
        env: entry.envVar ? { [entry.envVar]: 'set' } : {},
        removed
      })

      const reason = hit.refused ? hit.reason : ''
      if (entry.field) expect(reason).toContain(entry.field)
      if (entry.envVar) expect(reason).toContain(entry.envVar)
      expect(reason).toContain(entry.replacement)
    }
  })
})
