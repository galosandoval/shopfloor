import {
  environmentBlockBody,
  firesOn,
  parseGhTokenScopes,
  parseTriggers,
  promptTokensIn
} from './parse-facts'

describe('parseTriggers', () => {
  it('reads block sequences as well as inline lists', () => {
    const triggers = parseTriggers(
      [
        'name: A',
        'on:',
        '  issues:',
        '    types:',
        '      - labeled',
        '      - unlabeled',
        '  workflow_run:',
        '    workflows:',
        '      - "Test"',
        '    types:',
        '      - completed',
        'jobs:',
        '  build:',
        '    types: [ignored]'
      ].join('\n')
    )
    expect(triggers.events.issues).toEqual(['labeled', 'unlabeled'])
    expect(triggers.events.workflow_run).toEqual(['completed'])
    expect(triggers.workflowRunSources).toEqual(['Test'])
  })

  it('reads the quoted "on": spelling and an inline event list', () => {
    const triggers = parseTriggers('"on": [issues, workflow_run]\n')
    expect(Object.keys(triggers.events)).toEqual(['issues', 'workflow_run'])
    expect(triggers.events.issues).toBeUndefined()
  })

  it('ignores commented-out triggers', () => {
    const triggers = parseTriggers(
      'on:\n  issues:\n    types: [labeled] # the human edge\n  # workflow_run:\n'
    )
    expect(triggers.events.issues).toEqual(['labeled'])
    expect(triggers.events.workflow_run).toBeUndefined()
    expect('workflow_run' in triggers.events).toBe(false)
  })
})

describe('parseGhTokenScopes', () => {
  it("reads gh auth status's scope line", () => {
    expect(
      parseGhTokenScopes(
        "  - Token: gho_***\n  - Token scopes: 'gist', 'read:org', 'repo', 'workflow'\n"
      )
    ).toEqual(['gist', 'read:org', 'repo', 'workflow'])
  })

  it('answers unknown when no scope line was printed', () => {
    expect(
      parseGhTokenScopes('You are not logged into any GitHub hosts.')
    ).toBe('unknown')
  })
})

describe('firesOn', () => {
  it('treats an event with no types: as firing on all of them', () => {
    const triggers = parseTriggers('on:\n  issues:\n')
    expect(firesOn(triggers, 'issues', 'labeled')).toBe(true)
  })

  it('is false for an event the workflow never declares', () => {
    const triggers = parseTriggers('on:\n  issues:\n    types: [labeled]\n')
    expect(firesOn(triggers, 'workflow_run', 'completed')).toBe(false)
  })
})

describe('promptTokensIn', () => {
  it('reads each token once, whatever whitespace it was written with', () => {
    expect(
      promptTokensIn('{{ISSUE_NUMBER}} {{ BRANCH }} {{ISSUE_NUMBER}}')
    ).toEqual(['ISSUE_NUMBER', 'BRANCH'])
  })

  it('ignores a lowercase or malformed placeholder', () => {
    expect(promptTokensIn('{{issue}} {ISSUE} {{ISSUE_NUMBER}}')).toEqual([
      'ISSUE_NUMBER'
    ])
  })
})

describe('environmentBlockBody', () => {
  const START = '<!-- a -->'
  const END = '<!-- /a -->'

  it('answers what sits between the fences', () => {
    expect(
      environmentBlockBody(`x${START}\nbun test\n${END}y`, START, END)
    ).toBe('\nbun test\n')
  })

  it('answers null for an unterminated block rather than reading to the end', () => {
    expect(environmentBlockBody(`${START}\nbun test`, START, END)).toBeNull()
    expect(environmentBlockBody('no fences here', START, END)).toBeNull()
  })
})
