/**
 * The `node:child_process` stub every shell's wiring test needs, written once.
 *
 * Mocking is allowed only at the process boundary (`docs/testing.md`), which
 * means each shell that shells out gets the same stub: record the argv, answer
 * with canned stdout, or reject with something shaped like an `execFile`
 * failure. Three files had grown a copy of it. Not a `.test.ts` file, so
 * vitest does not collect it as a suite.
 *
 * **A module-level singleton, deliberately.** A `vi.mock` factory is hoisted
 * above the test file's own `const`s but runs when the subject imports the
 * mocked module — during the import phase, while those `const`s are still in
 * their temporal dead zone. A stub the test file constructs is unreachable
 * from the factory; one this module already owns is not. Vitest isolates each
 * test file in its own module graph, so the sharing stops at the file.
 */

import { EventEmitter } from 'node:events'

export interface ExecStubResponse {
  stdout?: string
  stderr?: string
  /**
   * Reject instead of resolving: a number is the child's exit code, `'spawn'`
   * is "the binary is not installed" — a rejection carrying no numeric code,
   * which shells treat differently from a non-zero exit.
   */
  fails?: number | 'spawn'
}

export interface ExecStubRoute {
  /** Matched against the whole `file arg arg` line. */
  match: RegExp
  response: ExecStubResponse
}

/** Every `[file, ...args]` the stub was called with, in order. */
export let calls: string[][] = []

/**
 * What a call answers with when no route matches it. Reassign per test; a
 * shell that runs one command needs nothing else.
 */
export let response: ExecStubResponse = {}

/**
 * Per-command answers for a shell that runs several, tried in order. First
 * match wins; an unmatched call falls through to {@link response}.
 */
export let routes: ExecStubRoute[] = []

/** Clear recorded calls and routes, and set the standing response. */
export function resetExecStub(standing: ExecStubResponse = {}): void {
  calls = []
  routes = []
  response = standing
}

/** Point the stub's unmatched-call answer somewhere new mid-test. */
export function respondWith(standing: ExecStubResponse): void {
  response = standing
}

/** Replace the per-command routing table. */
export function routeExecStub(next: ExecStubRoute[]): void {
  routes = next
}

/**
 * The module object to return from a `vi.mock('node:child_process')` factory:
 *
 * ```ts
 * vi.mock('node:child_process', () => execStubModule())
 * ```
 */
export function execStubModule(): { execFile: unknown; spawn: unknown } {
  const answerFor = (file: string, args: string[]) => {
    calls.push([file, ...args])
    const command = [file, ...args].join(' ')
    const routed = routes.find((route) => route.match.test(command))
    return { command, ...(routed?.response ?? response) }
  }

  const run = (file: string, args: string[]) => {
    const { command, stdout = '', stderr = '', fails } = answerFor(file, args)

    if (fails !== undefined) {
      return Promise.reject(
        Object.assign(new Error(`exec stub failed: ${command}`), {
          // 'spawn' becomes ENOENT — a string code, which is how Node reports
          // a binary that was never found, and how a shell tells "could not
          // run" apart from "ran and failed".
          code: fails === 'spawn' ? 'ENOENT' : fails,
          stdout,
          stderr
        })
      )
    }

    return Promise.resolve({ stdout, stderr })
  }

  // Shells reach the child through `promisify(execFile)`, so the custom symbol
  // is what they actually call — without it `promisify` would resolve to
  // stdout alone rather than to `{ stdout, stderr }`. The bare export exists
  // only to fail loudly if a shell ever calls it directly.
  //
  // Not extracted for `implement.test.ts` to share, though it hand-rolls the
  // same symbol: a `vi.mock` factory is hoisted above this file's imports, so
  // anything imported to build the mocked module is still in its temporal dead
  // zone when the factory runs. The duplication is what the hoisting costs.
  const execFile = () => {
    throw new Error('this shell only uses the promisified execFile')
  }
  Object.defineProperty(execFile, Symbol.for('nodejs.util.promisify.custom'), {
    value: run
  })

  return { execFile, spawn: spawnStub(answerFor) }
}

/**
 * The streaming half of the boundary, for a shell that reads a child's stdout
 * as it arrives rather than buffering it — the handoff's CI log fetch, which
 * streams precisely so a large log cannot cost it the tail.
 *
 * Answers from the same routing table as {@link execStubModule}'s `execFile`,
 * so a test states one expectation per command however the shell runs it. The
 * canned stdout arrives in **two chunks**, which is not cosmetic: a stub that
 * emits once would let a rolling-tail bug that drops everything but the final
 * chunk pass.
 */
function spawnStub(
  answerFor: (
    file: string,
    args: string[]
  ) => ExecStubResponse & { command: string }
) {
  return (file: string, args: string[]) => {
    const { stdout = '', stderr = '', fails } = answerFor(file, args)
    const child = new EventEmitter() as EventEmitter & {
      stdout: EventEmitter & { setEncoding: (encoding: string) => void }
      stderr: EventEmitter & { setEncoding: (encoding: string) => void }
    }
    const stream = () =>
      Object.assign(new EventEmitter(), { setEncoding: () => {} })

    child.stdout = stream()
    child.stderr = stream()

    setImmediate(() => {
      if (fails === 'spawn') {
        child.emit(
          'error',
          Object.assign(new Error('spawn stub'), { code: 'ENOENT' })
        )
        return
      }

      const half = Math.ceil(stdout.length / 2)
      if (stdout) {
        child.stdout.emit('data', stdout.slice(0, half))
        child.stdout.emit('data', stdout.slice(half))
      }
      if (stderr) child.stderr.emit('data', stderr)

      child.emit('close', fails === undefined ? 0 : fails)
    })

    return child
  }
}
