/**
 * Wiring for the spend gate's shell: that the actor and repository it resolves
 * reach the `gh` probe, and that what `gh` answers reaches the verdict. The
 * allow/refuse logic is tested pure in `authorization.test.ts`; re-asserting it
 * here would prove nothing about whether the probe is called — which is the
 * failure this file exists to catch.
 *
 * `gh` is stubbed at the process boundary, the only place mocking is allowed.
 */

import { runAuthorization } from './run-authorization'

let calls: string[][]
let response: { stdout?: string; stderr?: string; fails?: number | 'spawn' }

vi.mock('node:child_process', () => {
  const run = (file: string, args: string[]) => {
    calls.push([file, ...args])
    if (response.fails !== undefined) {
      return Promise.reject(
        Object.assign(new Error('stub failed'), {
          code: response.fails === 'spawn' ? 'ENOENT' : response.fails,
          stdout: response.stdout ?? '',
          stderr: response.stderr ?? ''
        })
      )
    }
    return Promise.resolve({
      stdout: response.stdout ?? '',
      stderr: response.stderr ?? ''
    })
  }
  const execFile = () => {
    throw new Error('this shell only uses the promisified execFile')
  }
  Object.defineProperty(execFile, Symbol.for('nodejs.util.promisify.custom'), {
    value: run
  })
  return { execFile }
})

beforeEach(() => {
  calls = []
  response = { stdout: 'admin\n' }
})

describe('runAuthorization', () => {
  it('probes the stated actor and repository', async () => {
    await runAuthorization({ actor: 'alice', repo: 'acme/widgets', env: {} })

    expect(calls).toEqual([
      [
        'gh',
        'api',
        'repos/acme/widgets/collaborators/alice/permission',
        '--jq',
        '.permission'
      ]
    ])
  })

  it('falls back to the runner’s GITHUB_ACTOR and GITHUB_REPOSITORY', async () => {
    await runAuthorization({
      env: { GITHUB_ACTOR: 'bob', GITHUB_REPOSITORY: 'acme/widgets' }
    })

    expect(calls[0]).toContain(
      'repos/acme/widgets/collaborators/bob/permission'
    )
  })

  it('reaches an authorized verdict on what gh printed', async () => {
    response = { stdout: 'write\n' }

    const { verdict, actor, repo } = await runAuthorization({
      actor: 'alice',
      repo: 'acme/widgets',
      env: {}
    })

    expect(verdict).toEqual({ authorized: true, permission: 'write' })
    expect({ actor, repo }).toEqual({ actor: 'alice', repo: 'acme/widgets' })
  })

  it('refuses a permission gh reported as not permitted', async () => {
    response = { stdout: 'read\n' }

    const { verdict } = await runAuthorization({
      actor: 'drive-by',
      repo: 'acme/widgets',
      env: {}
    })

    expect(verdict).toMatchObject({
      authorized: false,
      refusal: 'not-permitted'
    })
  })

  it('turns a failed probe into an undetermined refusal carrying gh’s reason', async () => {
    response = { fails: 1, stderr: 'gh: Not Found (HTTP 404)\nextra noise' }

    const { verdict } = await runAuthorization({
      actor: 'alice',
      repo: 'acme/widgets',
      env: {}
    })

    if (verdict.authorized) throw new Error('expected a refusal')
    expect(verdict.refusal).toBe('undetermined')
    expect(verdict.reason).toContain('gh: Not Found (HTTP 404)')
    expect(verdict.reason).not.toContain('extra noise')
  })

  it('refuses rather than throwing when gh is not installed', async () => {
    response = { fails: 'spawn' }

    const { verdict } = await runAuthorization({
      actor: 'alice',
      repo: 'acme/widgets',
      env: {}
    })

    expect(verdict).toMatchObject({
      authorized: false,
      refusal: 'undetermined'
    })
  })

  it('refuses without probing when the actor is unresolvable', async () => {
    const { verdict } = await runAuthorization({
      repo: 'acme/widgets',
      env: {}
    })

    expect(calls).toEqual([])
    expect(verdict).toMatchObject({
      authorized: false,
      refusal: 'undetermined'
    })
  })

  it('refuses a malformed actor without ever addressing the probe path', async () => {
    const { verdict } = await runAuthorization({
      actor: 'alice/../octocat',
      repo: 'acme/widgets',
      env: {}
    })

    expect(calls).toEqual([])
    expect(verdict).toMatchObject({
      authorized: false,
      refusal: 'undetermined'
    })
  })
})
