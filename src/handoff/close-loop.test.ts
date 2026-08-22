/**
 * Wiring for the success path's strip: that it commits the removal when there
 * was a trail, and touches the repository at all only when there was one.
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
import { DEFAULT_ATTEMPTS_DIR } from './handoff'
import { stripAttempts } from './strip-attempts'

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

describe('stripAttempts', () => {
  it('removes the trail and commits the removal', async () => {
    routeExecStub([
      {
        match: /git ls-files/,
        response: { stdout: '.agent/attempts/1.md\n.agent/attempts/2.md\n' }
      }
    ])

    const result = await stripAttempts({
      attemptsDir: DEFAULT_ATTEMPTS_DIR,
      cwd
    })

    expect(result).toMatchObject({ stripped: true, removed: 2 })
    expect(commands()).toContainEqual('git rm -r --quiet -- .agent/attempts')
    expect(commands().some((command) => command.includes(' commit '))).toBe(
      true
    )
  })

  it('commits nothing when there was no trail', async () => {
    const result = await stripAttempts({
      attemptsDir: DEFAULT_ATTEMPTS_DIR,
      cwd
    })

    expect(result).toMatchObject({ stripped: false, removed: 0 })
    expect(commands().some((command) => command.includes(' commit '))).toBe(
      false
    )
  })
})
