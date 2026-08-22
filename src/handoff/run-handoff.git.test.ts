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
 * test". The killed-run case is here for the same reason and one more: a real
 * repository is the only place "the file survived the kill" can mean *committed*
 * rather than merely written.
 */

import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { execFileSync } from 'node:child_process'
import { AGENT_COMMIT_AUTHOR, LOOP_CLOSED_TRAILER } from '../trigger/classify'
import { DEFAULT_ATTEMPTS_DIR } from './handoff'
import { describeRunawayKill, spawnClaude } from '../orchestration/spawn-claude'
import { writeHandoff, type WriteHandoffInput } from './run-handoff'
import { closeLoop } from './close-loop'

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

  /**
   * **The kill is real here, and that is the point** (shopfloor#49's "verified
   * by a test that kills the run"). Every other test of this path hands
   * `writeHandoff` a failure string somebody typed. This one runs a child that
   * will not stop, lets the idle guard actually kill it, and feeds the guard's
   * own verdict through — so the assertion is that a run nobody got to shut
   * down cleanly still leaves a committed file, rather than that a stub was
   * called with plausible prose.
   */
  it('still commits a file for a run the guards actually killed', async () => {
    const kill = await spawnClaude({
      command: process.execPath,
      // Silent and immortal: exactly what the idle guard exists for.
      args: ['-e', 'setInterval(() => {}, 1000)'],
      prompt: 'ignored-by-the-stand-in',
      env: process.env,
      cwd,
      idleMs: 50,
      checkIntervalMs: 5,
      sigtermGraceMs: 60,
      onSpawnError: () => {}
    })

    expect(kill.killedBy).not.toBeNull()

    const result = await writeHandoff(
      input({
        outcome: 'exhausted',
        failure: describeRunawayKill(kill.killedBy!),
        // Pointed at a file the killed run never got to write, which is the
        // whole reason the claims half has to say so rather than be omitted.
        claimsFile: path.join(cwd, 'claims-it-never-wrote.md')
      })
    )

    expect(result).toMatchObject({ written: true, committed: true })

    const document = fs.readFileSync(path.join(cwd, result.file), 'utf8')
    expect(document).toContain('killed by the')
    expect(document).toContain('claims-it-never-wrote.md')
    // The harness half is whole regardless — the guarantee the kill case exists
    // to prove.
    expect(document).toContain('## Harness — observed facts')
    expect(filesIn('HEAD')).toEqual(['A\t.agent/attempts/900.md'])
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

describe('closeLoop against real git', () => {
  const commitTrail = () => {
    fs.mkdirSync(path.join(cwd, DEFAULT_ATTEMPTS_DIR), { recursive: true })
    fs.writeFileSync(path.join(cwd, DEFAULT_ATTEMPTS_DIR, '1.md'), 'one\n')
    fs.writeFileSync(path.join(cwd, DEFAULT_ATTEMPTS_DIR, '2.md'), 'two\n')
    git('add', '-A')
    git('commit', '--quiet', '--no-verify', '-m', 'trail')
  }

  it('actually commits the removal — the whole point of the strip', async () => {
    commitTrail()

    const result = await closeLoop({
      attemptsDir: DEFAULT_ATTEMPTS_DIR,
      cwd
    })

    expect(result).toMatchObject({ closed: true, removed: 2 })
    // Committed, not merely staged: a run that leaves the deletion in the index
    // pushes a branch that still carries the trail.
    expect(git('ls-files', '--', DEFAULT_ATTEMPTS_DIR)).toBe('')
    expect(git('status', '--porcelain')).toBe('')
    expect(filesIn('HEAD').sort()).toEqual([
      'D\t.agent/attempts/1.md',
      'D\t.agent/attempts/2.md'
    ])
  })

  it('commits an empty mark when there is no trail, changing no file', async () => {
    const before = git('rev-parse', 'HEAD')

    const result = await closeLoop({
      attemptsDir: DEFAULT_ATTEMPTS_DIR,
      cwd
    })

    expect(result).toMatchObject({ closed: true, removed: 0 })
    // A new commit, and one that touches nothing: the mark is the whole of it,
    // and a working tree left dirty here would be swept into the next push.
    expect(git('rev-parse', 'HEAD')).not.toBe(before)
    expect(filesIn('HEAD')).toEqual([])
    expect(git('status', '--porcelain')).toBe('')
    expect(git('log', '-1', '--format=%B')).toContain(LOOP_CLOSED_TRAILER)
  })
})
