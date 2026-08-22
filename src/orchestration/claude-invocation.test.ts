import {
  prepareClaudeInvocation,
  type ClaudeInvocationInput
} from './claude-invocation'

const MODEL = 'claude-opus-4-8'
const MAX_TURNS = 150

function baseInput(
  overrides: Partial<ClaudeInvocationInput> = {}
): ClaudeInvocationInput {
  return {
    promptTemplate:
      'Implement #{{ISSUE_NUMBER}}: {{ISSUE_TITLE}} on {{BRANCH}}.\n' +
      'PR: {{PR_DESCRIPTION_FILE}}\n' +
      'Verify: {{VERIFY_REPORT_FILE}}\n' +
      'Shots: {{SCREENSHOTS_DIR}}\n' +
      'Attempts: {{ATTEMPTS_DIR}}\n' +
      'Claims: {{HANDOFF_CLAIMS_FILE}}\n',
    issueNumber: '540',
    issueTitle: 'Invoke Claude CLI directly',
    branch: 'agent/issue-540-invoke-claude-cli-directly',
    prDescriptionFile: '/tmp/out/pr_description.txt',
    verifyReportFile: '/tmp/out/verify_report.md',
    screenshotsDir: '.agent/verify/issue-540',
    attemptsDir: '.agent/attempts',
    handoffClaimsFile: '/tmp/out/handoff_claims.md',
    model: MODEL,
    maxTurns: MAX_TURNS,
    ...overrides
  }
}

describe('prepareClaudeInvocation', () => {
  describe('prompt rendering', () => {
    it('substitutes every placeholder with the matching input field', () => {
      const { prompt } = prepareClaudeInvocation(baseInput())

      expect(prompt).toBe(
        'Implement #540: Invoke Claude CLI directly on ' +
          'agent/issue-540-invoke-claude-cli-directly.\n' +
          'PR: /tmp/out/pr_description.txt\n' +
          'Verify: /tmp/out/verify_report.md\n' +
          'Shots: .agent/verify/issue-540\n' +
          'Attempts: .agent/attempts\n' +
          'Claims: /tmp/out/handoff_claims.md\n'
      )
    })

    it('no longer substitutes STANDARDS_DIR, leaving a stale template’s token as text', () => {
      // The removed placeholder (shopfloor#27) is now an unrecognized token
      // like any other. A run only reaches here with its configuration already
      // corrected, since a stated standards directory refuses before this.
      const { prompt } = prepareClaudeInvocation(
        baseInput({ promptTemplate: 'Standards: [{{STANDARDS_DIR}}]' })
      )

      expect(prompt).toBe('Standards: [{{STANDARDS_DIR}}]')
    })

    it('appends the previous iteration’s gate failure', () => {
      const { prompt } = prepareClaudeInvocation(
        baseInput({
          promptTemplate: 'Do the work.',
          iterationFeedback: 'The gate `bun test` failed.'
        })
      )

      expect(prompt).toBe('Do the work.\nThe gate `bun test` failed.\n')
    })

    it('leaves the prompt untouched when there is no feedback to carry', () => {
      // A first iteration, and every run with no gate stated, must render
      // byte-identically to a run from before the loop existed.
      const { prompt } = prepareClaudeInvocation(
        baseInput({ promptTemplate: 'Do the work.' })
      )

      expect(prompt).toBe('Do the work.')
    })

    it('leaves unrecognized tokens untouched', () => {
      const { prompt } = prepareClaudeInvocation(
        baseInput({
          promptTemplate: 'Known: {{ISSUE_NUMBER}}, unknown: {{NOT_A_FIELD}}'
        })
      )

      expect(prompt).toBe('Known: 540, unknown: {{NOT_A_FIELD}}')
    })
  })

  describe('argument vector', () => {
    it('assembles the headless CLI flags in order, without embedding the prompt', () => {
      const { args } = prepareClaudeInvocation(baseInput())

      expect(args).toEqual([
        '--print',
        '--model',
        MODEL,
        '--max-turns',
        String(MAX_TURNS),
        '--dangerously-skip-permissions'
      ])
    })

    it('sources the model and max-turns flags from the input, not a constant', () => {
      const { args } = prepareClaudeInvocation(
        baseInput({ model: 'claude-sonnet-5', maxTurns: 42 })
      )
      const modelValue = args[args.indexOf('--model') + 1]
      const maxTurnsValue = args[args.indexOf('--max-turns') + 1]

      expect(modelValue).toBe('claude-sonnet-5')
      expect(maxTurnsValue).toBe('42')
    })

    it('omits the model flag entirely when no model is configured, deferring to the CLI', () => {
      const { args } = prepareClaudeInvocation(baseInput({ model: undefined }))

      expect(args).toEqual([
        '--print',
        '--max-turns',
        String(MAX_TURNS),
        '--dangerously-skip-permissions'
      ])
    })

    it('leaves the arg vector unchanged when streamOutput is omitted', () => {
      const { args } = prepareClaudeInvocation(baseInput())

      expect(args).not.toContain('--output-format')
    })

    it('passes one --plugin-dir occurrence per stated entry, in order', () => {
      const { args } = prepareClaudeInvocation(
        baseInput({ pluginDirs: ['/plugins/skills', '/plugins/extra.zip'] })
      )

      expect(args).toEqual([
        '--print',
        '--model',
        MODEL,
        '--max-turns',
        String(MAX_TURNS),
        '--dangerously-skip-permissions',
        '--plugin-dir',
        '/plugins/skills',
        '--plugin-dir',
        '/plugins/extra.zip'
      ])
    })

    it('leaves the flag off entirely when no plugin dirs are stated', () => {
      const { args } = prepareClaudeInvocation(baseInput())

      expect(args).not.toContain('--plugin-dir')
    })

    it('leaves the flag off for an explicitly empty list', () => {
      const { args } = prepareClaudeInvocation(baseInput({ pluginDirs: [] }))

      expect(args).not.toContain('--plugin-dir')
    })

    it('wires the command guard as a PreToolUse hook over Bash when a hook script is given', () => {
      const { args } = prepareClaudeInvocation(
        baseInput({ commandGuardHookPath: '/pkg/dist/command-guard-hook.js' })
      )
      const settings = JSON.parse(args[args.indexOf('--settings') + 1])

      expect(settings).toEqual({
        hooks: {
          PreToolUse: [
            {
              matcher: 'Bash',
              hooks: [
                {
                  type: 'command',
                  command: 'node "/pkg/dist/command-guard-hook.js"'
                }
              ]
            }
          ]
        }
      })
    })

    it('leaves the settings flag off when no hook script is given', () => {
      const { args } = prepareClaudeInvocation(baseInput())

      expect(args).not.toContain('--settings')
    })

    it('appends the streaming flags when streamOutput is set', () => {
      const { args } = prepareClaudeInvocation(
        baseInput({ streamOutput: true })
      )

      expect(args).toEqual([
        '--print',
        '--model',
        MODEL,
        '--max-turns',
        String(MAX_TURNS),
        '--dangerously-skip-permissions',
        '--output-format',
        'stream-json',
        '--verbose',
        '--include-partial-messages'
      ])
    })
  })
})
