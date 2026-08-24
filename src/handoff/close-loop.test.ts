/**
 * Wiring for the success path's closing commit: that it removes the trail when
 * there was one, and marks the branch closed either way.
 *
 * What git actually does with those commands is `run-handoff.git.test.ts` —
 * this asserts what crosses the process boundary, which is the only thing a
 * stub can honestly answer.
 */

import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import {
  calls,
  execStubModule,
  resetExecStub,
  routeExecStub
} from '../process/exec-stub.test-helper'
import { LOOP_CLOSED_TRAILER } from '../trigger/classify'
import { DEFAULT_ATTEMPTS_DIR } from './handoff'
import { closeLoop } from './close-loop'

vi.mock('node:child_process', () => execStubModule())

let cwd: string

/** The `[file, ...args]` lines, joined, so a test can match on a whole command. */
const commands = () => calls.map((call) => call.join(' '))

beforeEach(() => {
  cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'shopfloor-strip-'))
  resetExecStub({ stdout: '' })
})

afterEach(() => {
  fs.rmSync(cwd, { recursive: true, force: true })
})

describe('closeLoop', () => {
  it('removes the trail and commits the removal', async () => {
    routeExecStub([
      {
        match: /git ls-files/,
        response: { stdout: '.agent/attempts/1.md\n.agent/attempts/2.md\n' }
      }
    ])

    const result = await closeLoop({
      attemptsDir: DEFAULT_ATTEMPTS_DIR,
      cwd
    })

    expect(result).toMatchObject({ closed: true, removed: 2 })
    expect(commands()).toContainEqual('git rm -r --quiet -- .agent/attempts')
    expect(commands().some((command) => command.includes(' commit '))).toBe(
      true
    )
  })

  it('marks the stripping commit as the one that closed the loop', async () => {
    // shopfloor#50: this commit is authored as the agent like the work beneath
    // it, and the trailer is the only thing that stops the machine edge
    // answering CI red on top of a finished run with another attempt.
    routeExecStub([
      { match: /git ls-files/, response: { stdout: '.agent/attempts/1.md\n' } }
    ])

    await closeLoop({ attemptsDir: DEFAULT_ATTEMPTS_DIR, cwd })

    const commit = calls.find((call) => call.includes('commit'))
    expect(commit?.join('\n')).toContain(`\n${LOOP_CLOSED_TRAILER}\n`)
    expect(commit).not.toContain('--allow-empty')
  })

  it('still commits the mark when there was no trail to strip', async () => {
    // A first-attempt success has nothing to delete, and it is the most likely
    // success there is — a mark made only when a trail existed would leave the
    // common case looking like a failed attempt to the machine edge.
    const result = await closeLoop({ attemptsDir: DEFAULT_ATTEMPTS_DIR, cwd })

    expect(result).toMatchObject({ closed: true, removed: 0 })
    expect(commands().some((command) => command.includes('git rm'))).toBe(false)

    const commit = calls.find((call) => call.includes('commit'))
    expect(commit).toContain('--allow-empty')
    expect(commit?.join('\n')).toContain(`\n${LOOP_CLOSED_TRAILER}\n`)
  })
})
