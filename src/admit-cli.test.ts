/**
 * What the bin alone owns: the split exit code, and that stdout carries the
 * verdict as parseable JSON. The verdicts themselves are tested next door with
 * nothing mocked — `gh` is stubbed at the process boundary here so an exit code
 * in this file is the one a runner gets.
 */

import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  execStubModule,
  resetExecStub,
  routeExecStub
} from './process/exec-stub.test-helper'
import issuesLabeled from './trigger/fixtures/issues-labeled.json'

vi.mock('node:child_process', () => execStubModule())

let exitCodes: number[]
let printed: { out: string[]; err: string[] }

beforeEach(() => {
  resetExecStub()
  routeExecStub([
    { match: /collaborators/, response: { stdout: 'admin\n' } },
    { match: /timeline/, response: { stdout: 'ready-for-agent\n' } },
    { match: /gh issue view/, response: { stdout: 'ready-for-agent\n' } }
  ])
  exitCodes = []
  printed = { out: [], err: [] }

  vi.resetModules()
  vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
    exitCodes.push(code ?? 0)
    return undefined as never
  }) as typeof process.exit)
  vi.spyOn(console, 'log').mockImplementation((line: string) => {
    printed.out.push(line)
  })
  vi.spyOn(console, 'error').mockImplementation((line: string) => {
    printed.err.push(line)
  })

  process.argv = ['node', 'admit-cli']
  process.env.GITHUB_WORKFLOW = 'Agent implement'
  process.env.GITHUB_RUN_ID = '5001'
  process.env.GITHUB_EVENT_PATH = writeEvent(issuesLabeled)
})

afterEach(() => {
  vi.restoreAllMocks()
  delete process.env.GITHUB_WORKFLOW
  delete process.env.GITHUB_RUN_ID
  delete process.env.GITHUB_EVENT_PATH
})

function writeEvent(payload: unknown): string {
  const path = join(
    mkdtempSync(join(tmpdir(), 'shopfloor-admit-cli-')),
    'event.json'
  )
  writeFileSync(path, JSON.stringify(payload), 'utf8')
  return path
}

/**
 * The entrypoint does its work on import, like every other bin here — but this
 * one reads a file *and* shells out before it prints, so a single tick is not
 * enough to see the end of it. It always prints exactly one line to stdout, so
 * that line is the signal that `main` has settled.
 */
async function runBin(): Promise<void> {
  await import('./admit-cli')

  for (let tick = 0; tick < 100 && printed.out.length === 0; tick++) {
    await new Promise((resolve) => setTimeout(resolve, 1))
  }
}

function verdict(): Record<string, unknown> {
  return JSON.parse(printed.out.join('\n'))
}

describe('shopfloor-admit', () => {
  it('exits zero and prints the admitted verdict as JSON', async () => {
    await runBin()

    expect(exitCodes).toEqual([])
    expect(verdict()).toMatchObject({
      admitted: true,
      phase: 'implement',
      issueNumber: 46,
      branch: 'agent/issue-46'
    })
    expect(printed.err.join('\n')).toContain('ADMITTED')
  })

  it('exits zero on an event that is not a trigger — nothing happened', async () => {
    process.env.GITHUB_EVENT_PATH = writeEvent({ action: 'opened' })

    await runBin()

    expect(exitCodes).toEqual([])
    expect(verdict()).toMatchObject({
      admitted: false,
      refusal: 'not-a-trigger'
    })
  })

  it('exits non-zero on an actor who may not spend', async () => {
    routeExecStub([{ match: /collaborators/, response: { stdout: 'read' } }])

    await runBin()

    expect(exitCodes).toEqual([1])
    expect(printed.err.join('\n')).toContain('REFUSED (not-permitted)')
  })

  it('exits non-zero when a probe could not answer', async () => {
    routeExecStub([{ match: /collaborators/, response: { fails: 'spawn' } }])

    await runBin()

    expect(exitCodes).toEqual([1])
    expect(verdict()).toMatchObject({ refusal: 'undetermined' })
  })

  it('honours --max-attempts', async () => {
    routeExecStub([
      { match: /collaborators/, response: { stdout: 'admin' } },
      { match: /timeline/, response: { stdout: 'agent:in-progress' } },
      { match: /gh issue view/, response: { stdout: '' } }
    ])
    process.argv = ['node', 'admit-cli', '--max-attempts', '1']

    await runBin()

    expect(exitCodes).toEqual([1])
    expect(verdict()).toMatchObject({ refusal: 'exhausted' })
  })

  it('refuses a --max-attempts that is not a number of runs', async () => {
    process.argv = ['node', 'admit-cli', '--max-attempts', 'lots']

    await runBin()

    expect(exitCodes[0]).toBe(1)
    expect(printed.err.join('\n')).toContain('--max-attempts')
  })
})
