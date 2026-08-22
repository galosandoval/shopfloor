/**
 * The handoff shell against **real git**, in a throwaway repository.
 *
 * Its sibling `run-handoff.test.ts` stubs the process boundary and asserts the
 * argv, which is the right shape for asserting what a shell hands across that
 * boundary. It is the wrong shape for asserting what git *does* with it, and
 * the difference is not academic: an earlier version of the strip staged its
 * deletion with `git rm` and then ran `git add` over a pathspec that by then
 * matched nothing in the worktree or the index. Git exits 128; the stub
 * answered happily; the trail survived on the branch and every test passed.
 *
 * So the cases here are the ones where git's own behaviour is the subject —
 * `docs/testing.md`, "prefer the real thing where the layout is the thing under
 * test".
 */

import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { execFileSync } from 'node:child_process'
import { AGENT_COMMIT_AUTHOR } from '../trigger/classify'
import { DEFAULT_ATTEMPTS_DIR } from './handoff'
import {
  stripAttempts,
  writeHandoff,
  type WriteHandoffInput
} from './run-handoff'

let cwd: string

const git = (...args: string[]) =>
  execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()

const input = (
  overrides: Partial<WriteHandoffInput> = {}
): WriteHandoffInput => ({
  attempt: 1,
  maxAttempts: 3,
  issueNumber: 49,
  repo: 'acme/widgets',
  branch: 'agent/issue-49',
  outcome: 'failed',
  failure: 'Claude CLI exited with status 1.',
  attemptsDir: DEFAULT_ATTEMPTS_DIR,
  cwd,
  env: { GITHUB_RUN_ID: '900' },
  ...overrides
})

/** The paths one commit touched, so a test can say what actually landed. */
const filesIn = (ref: string) =>
  git('show', '--name-status', '--format=', ref).split('\n').filter(Boolean)

beforeEach(() => {
  cwd = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'shopfloor-git-'))
  )
  git('init', '--quiet', '--initial-branch=main')
  git('config', 'user.email', 'nobody@example.test')
  git('config', 'user.name', 'Nobody')
  fs.writeFileSync(path.join(cwd, 'README.md'), 'base\n')
  git('add', '-A')
  git('commit', '--quiet', '--no-verify', '-m', 'base')
})

afterEach(() => {
  fs.rmSync(cwd, { recursive: true, force: true })
})

describe('writeHandoff against real git', () => {
  it('commits the attempt file, and only it', async () => {
    // Something else in the working tree, which a `git commit -a` would sweep
    // into a commit whose message is about a handoff.
    fs.writeFileSync(path.join(cwd, 'unrelated.txt'), 'the agent was here\n')

    const result = await writeHandoff(input())

    expect(result).toMatchObject({ written: true, committed: true })
    expect(filesIn('HEAD')).toEqual(['A\t.agent/attempts/900.md'])
    expect(git('status', '--porcelain')).toContain('unrelated.txt')
  })

  it('authors the commit as the agent, so the machine edge still fires', async () => {
    await writeHandoff(input())

    expect(git('log', '-1', '--format=%an')).toBe(AGENT_COMMIT_AUTHOR)
  })

  it('summarizes what the attempt changed against the repository’s own base', async () => {
    git('checkout', '--quiet', '-b', 'agent/issue-49')
    fs.writeFileSync(path.join(cwd, 'src.ts'), 'export const x = 1\n')
    git('add', '-A')
    git('commit', '--quiet', '--no-verify', '-m', 'work')

    const result = await writeHandoff(input())

    expect(fs.readFileSync(path.join(cwd, result.file), 'utf8')).toContain(
      'src.ts'
    )
  })
})

describe('stripAttempts against real git', () => {
  const commitTrail = () => {
    fs.mkdirSync(path.join(cwd, DEFAULT_ATTEMPTS_DIR), { recursive: true })
    fs.writeFileSync(path.join(cwd, DEFAULT_ATTEMPTS_DIR, '1.md'), 'one\n')
    fs.writeFileSync(path.join(cwd, DEFAULT_ATTEMPTS_DIR, '2.md'), 'two\n')
    git('add', '-A')
    git('commit', '--quiet', '--no-verify', '-m', 'trail')
  }

  it('actually commits the removal — the whole point of the strip', async () => {
    commitTrail()

    const result = await stripAttempts({
      attemptsDir: DEFAULT_ATTEMPTS_DIR,
      cwd
    })

    expect(result).toMatchObject({ stripped: true, removed: 2 })
    // Committed, not merely staged: a run that leaves the deletion in the index
    // pushes a branch that still carries the trail.
    expect(git('ls-files', '--', DEFAULT_ATTEMPTS_DIR)).toBe('')
    expect(git('status', '--porcelain')).toBe('')
    expect(filesIn('HEAD').sort()).toEqual([
      'D\t.agent/attempts/1.md',
      'D\t.agent/attempts/2.md'
    ])
  })

  it('leaves the repository alone when there is no trail', async () => {
    const before = git('rev-parse', 'HEAD')

    const result = await stripAttempts({
      attemptsDir: DEFAULT_ATTEMPTS_DIR,
      cwd
    })

    expect(result).toMatchObject({ stripped: false, removed: 0 })
    expect(git('rev-parse', 'HEAD')).toBe(before)
  })
})
