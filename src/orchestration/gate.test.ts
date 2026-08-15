/**
 * The gate runner, against real short-lived commands rather than a mocked
 * `spawnSync` — the whole of what this module does is get a shell command's
 * exit status and output out of a subprocess, and a mocked one would only test
 * the mock. That it is the harness running this, and that a failure iterates,
 * lives in `implement.test.ts`.
 */

import { runGate } from './gate'

const opts = { cwd: process.cwd(), env: process.env }

describe('runGate', () => {
  it('passes on a zero exit', () => {
    expect(runGate('exit 0', opts)).toMatchObject({
      command: 'exit 0',
      passed: true
    })
  })

  it('fails on a non-zero exit', () => {
    expect(runGate('exit 3', opts).passed).toBe(false)
  })

  it('keeps stdout and stderr for the next turn to read', () => {
    const result = runGate('echo out; echo err 1>&2; exit 1', opts)

    expect(result.outputTail).toContain('out')
    expect(result.outputTail).toContain('err')
  })

  it('runs in the stated cwd', () => {
    expect(runGate('pwd', { ...opts, cwd: '/' }).outputTail).toContain('/')
  })

  it('fails rather than throwing when the command does not exist', () => {
    const result = runGate('definitely-not-a-command-here', opts)

    expect(result.passed).toBe(false)
    expect(result.outputTail.length).toBeGreaterThan(0)
  })

  it('bounds a chatty gate’s output', () => {
    const result = runGate(
      `node -e "process.stdout.write('x'.repeat(200000))"; exit 1`,
      opts
    )

    expect(result.outputTail.length).toBeLessThanOrEqual(4_000)
  })
})
