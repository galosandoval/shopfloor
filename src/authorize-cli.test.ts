/**
 * The one thing the bin alone can get wrong: its exit code. `runAuthorization`
 * is tested next door — what is untested anywhere else is whether a refusal
 * this process cannot resolve still leaves non-zero, which is the whole
 * contract of a spend gate that runs before the spend.
 *
 * `gh` is stubbed at the process boundary and `process.exit` is intercepted
 * (stubbing it is what lets a test observe the code instead of dying on it);
 * the guard underneath is real, so an exit code here is the one a runner gets.
 */

import {
  execStubModule,
  resetExecStub,
  respondWith
} from './process/exec-stub.test-helper'

vi.mock('node:child_process', () => execStubModule())

let exitCodes: number[]
let printed: { out: string[]; err: string[] }

beforeEach(() => {
  resetExecStub({ stdout: 'admin\n' })
  exitCodes = []
  printed = { out: [], err: [] }

  vi.resetModules()
  vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
    exitCodes.push(code ?? 0)
    // The real one never returns; this one has to, so `main` runs to its end.
    // Nothing after an exit in that file depends on not having run.
    return undefined as never
  }) as typeof process.exit)
  vi.spyOn(console, 'log').mockImplementation((line: string) => {
    printed.out.push(line)
  })
  vi.spyOn(console, 'error').mockImplementation((line: string) => {
    printed.err.push(line)
  })

  process.env.GITHUB_ACTOR = 'alice'
  process.env.GITHUB_REPOSITORY = 'acme/widgets'
})

afterEach(() => {
  vi.restoreAllMocks()
  delete process.env.GITHUB_ACTOR
  delete process.env.GITHUB_REPOSITORY
})

/**
 * The entrypoint does its work on import, so each case re-imports it after
 * `vi.resetModules()` and waits for the floating `main()` to settle.
 */
async function runBin(): Promise<void> {
  await import('./authorize-cli')
  await new Promise((resolve) => setImmediate(resolve))
}

describe('shopfloor-authorize', () => {
  it('exits zero and names the permission when the actor may spend', async () => {
    await runBin()

    expect(exitCodes).toEqual([])
    expect(printed.out.join('\n')).toContain('alice')
    expect(printed.out.join('\n')).toContain('admin')
  })

  it('exits non-zero when the actor is not permitted', async () => {
    respondWith({ stdout: 'read\n' })

    await runBin()

    expect(exitCodes).toEqual([1])
    expect(printed.err.join('\n')).toContain('REFUSED (not-permitted)')
  })

  it('exits non-zero when the permission could not be determined', async () => {
    // The behaviour this command must never have is exiting zero here: an
    // unreadable permission is not permission, and a token that stopped
    // working must not read as an authorized run.
    respondWith({ fails: 'spawn' })

    await runBin()

    expect(exitCodes).toEqual([1])
    expect(printed.err.join('\n')).toContain('REFUSED (undetermined)')
  })

  it('exits non-zero when the target itself is unresolvable', async () => {
    delete process.env.GITHUB_ACTOR

    await runBin()

    expect(exitCodes).toEqual([1])
    expect(printed.err.join('\n')).toContain('REFUSED (undetermined)')
  })
})
