import { classifyCommand, type BlockedVerdict } from './command-policy'

/** The verdict, asserted to be a block so the message fields are readable. */
function blockFor(command: string): BlockedVerdict {
  const verdict = classifyCommand(command)
  if (verdict.decision !== 'block') {
    throw new Error(`Expected a block for: ${command}`)
  }
  return verdict
}

function expectAllowed(...commands: string[]) {
  for (const command of commands) {
    expect([command, classifyCommand(command).decision]).toEqual([
      command,
      'allow'
    ])
  }
}

function expectBlocked(...commands: string[]) {
  for (const command of commands) {
    expect([command, classifyCommand(command).decision]).toEqual([
      command,
      'block'
    ])
  }
}

describe('classifyCommand', () => {
  describe('schema pushes', () => {
    it('blocks a direct schema push', () => {
      expectBlocked('prisma db push')
    })

    it('blocks it behind any package runner', () => {
      expectBlocked(
        'npx prisma db push',
        'bunx prisma db push',
        'pnpm dlx prisma db push',
        'yarn prisma db push',
        'npm exec prisma db push',
        'npx --yes prisma@latest db push',
        './node_modules/.bin/prisma db push'
      )
    })

    it('blocks it whatever flags ride along', () => {
      expectBlocked(
        'bunx prisma db push --accept-data-loss',
        'bunx prisma db push --force-reset --skip-generate',
        'bunx prisma --schema=prisma/schema.prisma db push'
      )
    })

    it('allows every other prisma subcommand, migrations included', () => {
      expectAllowed(
        'bunx prisma migrate dev --name add_pantry',
        'bunx prisma migrate deploy',
        'bunx prisma migrate reset',
        'bunx prisma generate',
        'bunx prisma db seed',
        'bunx prisma db execute --file seed.sql',
        'bunx prisma studio'
      )
    })

    it('names the migration as the sanctioned alternative', () => {
      const verdict = blockFor('bunx prisma db push')

      expect(verdict.reason).toMatch(/db push/)
      expect(verdict.alternative).toMatch(/prisma migrate dev/)
    })
  })

  describe('force pushes', () => {
    it('blocks the long, short, and lease variants', () => {
      expectBlocked(
        'git push --force',
        'git push -f',
        'git push --force-with-lease',
        'git push --force-with-lease=origin/main',
        'git push --force-if-includes'
      )
    })

    it('blocks whatever the flag order or the git-level options are', () => {
      expectBlocked(
        'git push origin agent/issue-567 --force',
        'git push --force origin agent/issue-567',
        'git push -fu origin agent/issue-567',
        'git -C /repo push --force origin main',
        'git --no-pager push --force'
      )
    })

    it('blocks the leading-plus refspec, which forces without a flag', () => {
      expectBlocked(
        'git push origin +main',
        'git push origin +HEAD:agent/issue-567',
        'git push --no-verify origin +refs/heads/main:refs/heads/main'
      )
    })

    it('allows an ordinary push', () => {
      expectAllowed(
        'git push',
        'git push origin agent/issue-567',
        'git push -u origin agent/issue-567',
        'git push --set-upstream origin agent/issue-567',
        'git push --no-verify origin main'
      )
    })

    it('says to add a commit instead of rewriting the remote', () => {
      const verdict = blockFor('git push --force')

      expect(verdict.reason).toMatch(/force/i)
      expect(verdict.alternative).toMatch(/commit/i)
    })
  })

  describe('amends', () => {
    it('blocks an amend however it is spelled', () => {
      expectBlocked(
        'git commit --amend',
        'git commit --amend --no-edit',
        'git commit -a --amend -m "fix"',
        'git commit --amend -m "reworded"',
        'git -C /repo commit --amend'
      )
    })

    it('allows an ordinary commit', () => {
      expectAllowed(
        'git commit -m "feat: add the pantry filter"',
        'git commit -am "fix: guard the empty case"',
        'git commit --no-verify -m "chore: wip"',
        'git commit -m "docs: explain --amend is blocked"'
      )
    })

    it('says to make a new commit instead', () => {
      const verdict = blockFor('git commit --amend')

      expect(verdict.reason).toMatch(/amend/i)
      expect(verdict.alternative).toMatch(/new commit/i)
    })
  })

  describe('compound commands', () => {
    it('blocks a forbidden operation anywhere in a chain', () => {
      expectBlocked(
        'bun run typecheck && git commit --amend --no-edit',
        'git add -A; git commit --amend',
        'git fetch origin || git push --force',
        'echo one\nbunx prisma db push',
        'git add -A && git commit -m "wip" && git push --force'
      )
    })

    it('leaves an all-clean chain alone', () => {
      expectAllowed(
        'bun run typecheck && bun run lint && bun run test',
        'git add -A && git commit -m "feat: x" && git push origin agent/issue-567'
      )
    })
  })

  describe('ordinary work', () => {
    it('allows the commands an implement run actually runs', () => {
      expectAllowed(
        'bun install',
        'bun run test',
        'bunx jest src/server/api',
        'git status --short',
        'git add -A',
        'git log --oneline -5',
        'gh issue view 567 --comments',
        'bun run seed',
        'bun run test:e2e',
        'rm -rf .next'
      )
    })

    it('allows an empty or whitespace-only command', () => {
      expectAllowed('', '   ')
    })
  })
})
