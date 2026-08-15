/**
 * Wiring for the spend gate's shell: that the actor and repository it resolves
 * reach the `gh` probe, and that what `gh` answers reaches the verdict. The
 * allow/refuse logic is tested pure in `authorization.test.ts`; re-asserting it
 * here would prove nothing about whether the probe is called — which is the
 * failure this file exists to catch.
 *
 * `gh` is stubbed at the process boundary, the only place mocking is allowed.
 */

import {
  calls,
  execStubModule,
  resetExecStub,
  respondWith
} from '../process/exec-stub.test-helper'
import { runAuthorization } from './run-authorization'

vi.mock('node:child_process', () => execStubModule())

beforeEach(() => {
  resetExecStub({ stdout: 'admin\n' })
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
        // `role_name`, not the legacy `permission` field: that one collapses
        // `maintain` into `write` and `triage` into `read`, so two of the
        // levels the pure guard judges could never reach it.
        '.role_name // .permission'
      ]
    ])
  })

  it('reaches an authorized verdict on a role only role_name reports', async () => {
    respondWith({ stdout: 'maintain\n' })

    const { verdict } = await runAuthorization({
      actor: 'alice',
      repo: 'acme/widgets',
      env: {}
    })

    expect(verdict).toEqual({ authorized: true, permission: 'maintain' })
  })

  it('refuses a triage collaborator — labeling is not spending', async () => {
    respondWith({ stdout: 'triage\n' })

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

  it('falls back to the runner’s GITHUB_ACTOR and GITHUB_REPOSITORY', async () => {
    await runAuthorization({
      env: { GITHUB_ACTOR: 'bob', GITHUB_REPOSITORY: 'acme/widgets' }
    })

    expect(calls[0]).toContain(
      'repos/acme/widgets/collaborators/bob/permission'
    )
  })

  it('reaches an authorized verdict on what gh printed', async () => {
    respondWith({ stdout: 'write\n' })

    const { verdict, actor, repo } = await runAuthorization({
      actor: 'alice',
      repo: 'acme/widgets',
      env: {}
    })

    expect(verdict).toEqual({ authorized: true, permission: 'write' })
    expect({ actor, repo }).toEqual({ actor: 'alice', repo: 'acme/widgets' })
  })

  it('refuses a permission gh reported as not permitted', async () => {
    respondWith({ stdout: 'read\n' })

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
    respondWith({ fails: 1, stderr: 'gh: Not Found (HTTP 404)\nextra noise' })

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
    respondWith({ fails: 'spawn' })

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
    if (verdict.authorized) throw new Error('expected a refusal')
    expect(verdict.refusal).toBe('undetermined')
    // The reason is about the malformed target, not about a probe result the
    // shell invented to stand in for the one it never took.
    expect(verdict.reason).toContain('is not a GitHub login')
  })
})
