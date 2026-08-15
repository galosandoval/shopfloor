import {
  ENVIRONMENT_BLOCK_END,
  ENVIRONMENT_BLOCK_START,
  ENVIRONMENT_UNFILLED_SENTINEL,
  evaluateSetup,
  formatSetupReport,
  PROMPT_TOKENS,
  REQUIRED_LABELS,
  type SetupCheckId,
  type SetupFacts
} from './setup'

const GOOD_WORKFLOW = `name: Agent implement
on:
  issues:
    types: [labeled]
  workflow_run:
    workflows: ['Test']
    types: [completed]
jobs:
  implement:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          token: \${{ secrets.AGENT_PAT }}
`

const GOOD_PROMPT = [
  '# Implement',
  ...PROMPT_TOKENS.map((token) => `{{${token}}}`),
  ENVIRONMENT_BLOCK_START,
  'Run `bun run typecheck && bun test`.',
  ENVIRONMENT_BLOCK_END
].join('\n')

/** A setup with nothing wrong with it; each test bends one thing out of shape. */
function facts(overrides: Partial<SetupFacts> = {}): SetupFacts {
  return {
    requiredSecrets: ['CLAUDE_CODE_OAUTH_TOKEN', 'AGENT_PAT'],
    patSecret: 'AGENT_PAT',
    ghAuth: 'authenticated',
    ghTokenScopes: ['repo', 'workflow'],
    repoSecrets: ['CLAUDE_CODE_OAUTH_TOKEN', 'AGENT_PAT'],
    repoLabels: [...REQUIRED_LABELS],
    runningCliVersion: '2.1.220 (Claude Code)',
    pinnedCliVersion: '2.1.220',
    promptTemplate: GOOD_PROMPT,
    workflow: GOOD_WORKFLOW,
    workflowFile: '.github/workflows/agent-implement.yml',
    defaultBranchWorkflowFiles: ['agent-implement.yml', 'test.yml'],
    ...overrides
  }
}

/** The status of one check, by id — every assertion below is about one binding. */
function statusOf(id: SetupCheckId, overrides: Partial<SetupFacts> = {}) {
  const check = evaluateSetup(facts(overrides)).checks.find((c) => c.id === id)
  if (!check) throw new Error(`no check ${id}`)
  return check
}

describe('evaluateSetup', () => {
  it('passes a setup with every binding correct', () => {
    const verdict = evaluateSetup(facts())
    expect(verdict.ok).toBe(true)
    expect(verdict.failures).toEqual([])
    expect(verdict.checks.every((check) => check.status === 'ok')).toBe(true)
  })

  it('lists every failing binding rather than stopping at the first', () => {
    const verdict = evaluateSetup(
      facts({
        ghAuth: 'unauthenticated',
        repoSecrets: [],
        repoLabels: []
      })
    )
    expect(verdict.ok).toBe(false)
    expect(verdict.failures.map((failure) => failure.id)).toEqual([
      'gh-auth',
      'repo-secrets',
      'label-vocabulary'
    ])
  })

  describe('gh auth and PAT scope', () => {
    it('fails an unauthenticated gh', () => {
      expect(statusOf('gh-auth', { ghAuth: 'unauthenticated' }).status).toBe(
        'fail'
      )
    })

    it('does not fail when gh could not be run at all', () => {
      const verdict = evaluateSetup(
        facts({ ghAuth: 'unknown', ghTokenScopes: 'unknown' })
      )
      expect(statusOf('gh-auth', { ghAuth: 'unknown' }).status).toBe('unknown')
      expect(verdict.ok).toBe(true)
    })

    it('fails a token with no workflow scope, naming the scope', () => {
      const check = statusOf('pat-workflow-scope', { ghTokenScopes: ['repo'] })
      expect(check.status).toBe('fail')
      expect(check.detail).toContain('workflow')
    })
  })

  describe('secrets', () => {
    it('fails and names each missing secret', () => {
      const check = statusOf('repo-secrets', {
        repoSecrets: ['CLAUDE_CODE_OAUTH_TOKEN']
      })
      expect(check.status).toBe('fail')
      expect(check.detail).toContain('AGENT_PAT')
    })

    it('checks the secret names the caller stated, not the defaults', () => {
      const check = statusOf('repo-secrets', {
        requiredSecrets: ['OTHER_TOKEN'],
        repoSecrets: ['CLAUDE_CODE_OAUTH_TOKEN', 'AGENT_PAT']
      })
      expect(check.status).toBe('fail')
      expect(check.detail).toContain('OTHER_TOKEN')
    })

    it('reports unknown when gh secret list could not be read', () => {
      expect(statusOf('repo-secrets', { repoSecrets: 'unknown' }).status).toBe(
        'unknown'
      )
    })
  })

  describe('label vocabulary', () => {
    it('fails and names the missing label', () => {
      const check = statusOf('label-vocabulary', {
        repoLabels: REQUIRED_LABELS.filter(
          (label) => label !== 'ready-for-human'
        )
      })
      expect(check.status).toBe('fail')
      expect(check.detail).toContain('ready-for-human')
    })

    it('ignores labels the repository has beyond the vocabulary', () => {
      expect(
        statusOf('label-vocabulary', {
          repoLabels: [...REQUIRED_LABELS, 'bug', 'good first issue']
        }).status
      ).toBe('ok')
    })
  })

  describe('CLI pin', () => {
    it('fails a running CLI whose minor differs from the pin', () => {
      const check = statusOf('cli-version-pin', {
        runningCliVersion: '2.2.0 (Claude Code)'
      })
      expect(check.status).toBe('fail')
      expect(check.detail).toContain('2.1.220')
    })

    it('passes a patch-level difference', () => {
      expect(
        statusOf('cli-version-pin', {
          runningCliVersion: '2.1.9 (Claude Code)'
        }).status
      ).toBe('ok')
    })

    it('reports unknown, not fail, when no pin was stated', () => {
      expect(
        statusOf('cli-version-pin', { pinnedCliVersion: undefined }).status
      ).toBe('unknown')
    })

    it('reports unknown when claude --version answered nothing', () => {
      expect(
        statusOf('cli-version-pin', { runningCliVersion: undefined }).status
      ).toBe('unknown')
    })
  })

  describe('prompt tokens', () => {
    it('fails a prompt missing a substituted token, naming it', () => {
      const check = statusOf('prompt-tokens', {
        promptTemplate: GOOD_PROMPT.replace('{{VERIFY_REPORT_FILE}}', '')
      })
      expect(check.status).toBe('fail')
      expect(check.detail).toContain('VERIFY_REPORT_FILE')
    })

    it('fails an unrecognized token, which today renders as literal text', () => {
      const check = statusOf('prompt-tokens', {
        promptTemplate: `${GOOD_PROMPT}\n{{STANDARDS_DIR}}`
      })
      expect(check.status).toBe('fail')
      expect(check.detail).toContain('{{STANDARDS_DIR}}')
      expect(check.detail).toContain('literal text')
    })

    it('reads a token whatever whitespace it was written with', () => {
      expect(
        statusOf('prompt-tokens', {
          promptTemplate: GOOD_PROMPT.replace(
            '{{ISSUE_TITLE}}',
            '{{ ISSUE_TITLE }}'
          )
        }).status
      ).toBe('ok')
    })

    it('reports unknown when no prompt was pointed at', () => {
      expect(statusOf('prompt-tokens', { promptTemplate: null }).status).toBe(
        'unknown'
      )
    })
  })

  describe('environment block', () => {
    it('fails a block still carrying the scaffold sentinel', () => {
      const check = statusOf('prompt-environment-block', {
        promptTemplate: [
          ENVIRONMENT_BLOCK_START,
          `${ENVIRONMENT_UNFILLED_SENTINEL}: name this repo's gate commands.`,
          ENVIRONMENT_BLOCK_END
        ].join('\n')
      })
      expect(check.status).toBe('fail')
      expect(check.detail).toContain(ENVIRONMENT_UNFILLED_SENTINEL)
    })

    it('fails an empty block', () => {
      expect(
        statusOf('prompt-environment-block', {
          promptTemplate: `${ENVIRONMENT_BLOCK_START}\n\n${ENVIRONMENT_BLOCK_END}`
        }).status
      ).toBe('fail')
    })

    it('reports unknown for a prompt carrying no block at all', () => {
      const check = statusOf('prompt-environment-block', {
        promptTemplate: '# Implement {{ISSUE_NUMBER}}'
      })
      expect(check.status).toBe('unknown')
      expect(check.detail).toContain(ENVIRONMENT_BLOCK_START)
    })

    it('reports unknown for an unterminated block rather than reading past it', () => {
      expect(
        statusOf('prompt-environment-block', {
          promptTemplate: `${ENVIRONMENT_BLOCK_START}\nbun run test`
        }).status
      ).toBe('unknown')
    })
  })

  describe('workflow triggers', () => {
    it('fails a workflow wired to neither admitted event', () => {
      const check = statusOf('workflow-triggers', {
        workflow: 'name: CI\non:\n  push:\n    branches: [main]\n'
      })
      expect(check.status).toBe('fail')
      expect(check.detail).toContain('issues.labeled')
      expect(check.detail).toContain('workflow_run.completed')
    })

    it('fails a workflow carrying only the human edge', () => {
      const check = statusOf('workflow-triggers', {
        workflow: 'name: A\non:\n  issues:\n    types: [labeled]\n'
      })
      expect(check.status).toBe('fail')
      expect(check.detail).toContain('workflow_run.completed')
      expect(check.detail).toContain('fan of triggers')
      // Only the missing edge is named — a report that lists both reads as two
      // problems when one of them is already wired.
      expect(check.detail).not.toContain('issues.labeled')
    })

    it('fails an issues trigger filtered to other activity types', () => {
      expect(
        statusOf('workflow-triggers', {
          workflow: GOOD_WORKFLOW.replace('types: [labeled]', 'types: [opened]')
        }).status
      ).toBe('fail')
    })

    it('passes an event that filters no activity types at all', () => {
      expect(
        statusOf('workflow-triggers', {
          workflow:
            'name: A\non:\n  issues:\n  workflow_run:\n    workflows: [Test]\n'
        }).status
      ).toBe('ok')
    })

    it('reports unknown when there is no readable workflow', () => {
      const check = statusOf('workflow-triggers', { workflow: null })
      expect(check.status).toBe('unknown')
      expect(check.detail).toContain('.github/workflows/agent-implement.yml')
    })
  })

  describe('workflow_run prerequisites', () => {
    it('fails a workflow absent from the default branch', () => {
      const check = statusOf('workflow-run-prerequisites', {
        defaultBranchWorkflowFiles: ['test.yml']
      })
      expect(check.status).toBe('fail')
      expect(check.detail).toContain('default branch')
    })

    it('fails a workflow that never references the PAT', () => {
      const check = statusOf('workflow-run-prerequisites', {
        workflow: GOOD_WORKFLOW.replace(
          'secrets.AGENT_PAT',
          'secrets.GITHUB_TOKEN'
        )
      })
      expect(check.status).toBe('fail')
      expect(check.detail).toContain('AGENT_PAT')
      expect(check.detail).toContain('no downstream events')
    })

    it('reports unknown, not fail, when only the default branch was unreadable', () => {
      expect(
        statusOf('workflow-run-prerequisites', {
          defaultBranchWorkflowFiles: 'unknown'
        }).status
      ).toBe('unknown')
    })

    it('reports unknown when the workflow declares no machine edge', () => {
      expect(
        statusOf('workflow-run-prerequisites', {
          workflow: 'name: A\non:\n  issues:\n    types: [labeled]\n'
        }).status
      ).toBe('unknown')
    })
  })
})

describe('formatSetupReport', () => {
  it('marks each check and states the verdict', () => {
    const report = formatSetupReport(evaluateSetup(facts()))
    expect(report).toContain('✓ label vocabulary')
    expect(report).toContain('Setup looks correct.')
  })

  it('repeats failures with what to fix, and separates unknowns', () => {
    const report = formatSetupReport(
      evaluateSetup(facts({ repoSecrets: [], promptTemplate: null }))
    )
    expect(report).toContain('1 failing:')
    expect(report).toContain('- repo-secrets: missing: CLAUDE_CODE_OAUTH_TOKEN')
    expect(report).toContain('unchecked (not a failure):')
    expect(report).toContain('Setup is incomplete.')
  })
})
