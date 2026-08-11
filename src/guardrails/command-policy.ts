/**
 * The pure command policy behind the run's `PreToolUse` guard (shopfloor#2):
 * a shell command string in, a verdict out. Three operations an autonomous
 * implement run must never perform — pushing a schema straight at the database
 * instead of writing a migration, force-pushing, and amending — are prose
 * obligations in every prompt, which means static context the model can drop
 * under pressure and a violation only noticed after it has already landed.
 * Classifying them here lets {@link classifyCommand} back a hook that refuses
 * the tool call outright.
 *
 * The policy is deliberately strict rather than clever: a command is scanned
 * as a shell-ish token stream (quote-aware, split on `&&`, `||`, `;`, `|`, and
 * newlines), and any segment that reads as a forbidden operation blocks the
 * whole call. Text that merely mentions a forbidden flag inside quotes — a
 * commit message, an `echo` — is data, not a flag, and passes.
 *
 * No IO here: `command-guard-hook.ts` is the thin adapter that reads the CLI's
 * hook JSON off stdin and turns a block into a refusal.
 */

/** A command the run must not execute, with the sanctioned way to do it instead. */
export interface BlockedVerdict {
  decision: 'block'
  /** Stable identifier for the rule that fired, for logs and tests. */
  rule: 'schema-push' | 'force-push' | 'amend'
  /** What was refused and why. */
  reason: string
  /** What to do instead — a blocked agent needs a next move, not just a no. */
  alternative: string
}

export type CommandVerdict = { decision: 'allow' } | BlockedVerdict

const ALLOW: CommandVerdict = { decision: 'allow' }

/**
 * Classify a shell command against the run's forbidden operations. Total: any
 * string is a valid input, and anything the policy doesn't recognize is
 * allowed — the guard exists to stop three specific operations, not to
 * whitelist a shell.
 */
export function classifyCommand(command: string): CommandVerdict {
  for (const segment of splitSegments(tokenize(command))) {
    const verdict = classifySegment(segment)
    if (verdict.decision === 'block') return verdict
  }
  return ALLOW
}

/** One word of a command line, and whether it arrived quoted (data, not syntax). */
interface Token {
  value: string
  quoted: boolean
}

/** The unquoted operators that end one command and begin another. */
const SEPARATORS = ['&&', '||', ';', '|', '\n']

/**
 * Split a command line into words, keeping track of which ones were quoted and
 * emitting the unquoted control operators as words of their own. Not a shell
 * parser — it understands quoting and separators, which is all the policy
 * needs to tell a flag from a commit message.
 */
function tokenize(command: string): Token[] {
  const tokens: Token[] = []
  let value = ''
  let quoted = false
  let openQuote: string | null = null

  const flush = () => {
    if (value !== '' || quoted) tokens.push({ value, quoted })
    value = ''
    quoted = false
  }

  for (let index = 0; index < command.length; index += 1) {
    const char = command[index]

    if (openQuote) {
      if (char === openQuote) openQuote = null
      else value += char
      continue
    }

    if (char === '"' || char === "'") {
      openQuote = char
      quoted = true
      continue
    }

    if (char === '\\' && index + 1 < command.length) {
      // An escaped character is literal text, never syntax.
      index += 1
      value += command[index]
      continue
    }

    if (char === '\n' || char === ';') {
      flush()
      tokens.push({ value: char, quoted: false })
      continue
    }

    if (char === '&' || char === '|') {
      flush()
      const doubled = command[index + 1] === char
      if (doubled) index += 1
      tokens.push({ value: doubled ? char + char : char, quoted: false })
      continue
    }

    if (/\s/.test(char)) {
      flush()
      continue
    }

    value += char
  }
  flush()

  return tokens
}

/** The token stream cut into one list per command in the chain. */
function splitSegments(tokens: Token[]): Token[][] {
  const segments: Token[][] = [[]]
  for (const token of tokens) {
    if (!token.quoted && SEPARATORS.includes(token.value)) segments.push([])
    else segments[segments.length - 1].push(token)
  }
  return segments
}

function classifySegment(tokens: Token[]): CommandVerdict {
  return (
    classifySchemaPush(tokens) ?? classifyGit(tokens) ?? ALLOW
  )
}

/**
 * `prisma db push` — however it is invoked. The command name is matched by its
 * basename so a package-runner prefix (`npx`, `bunx`, `pnpm dlx`) or a direct
 * `node_modules/.bin` path all read the same, and flags anywhere in the
 * invocation are stepped over.
 */
function classifySchemaPush(tokens: Token[]): CommandVerdict | null {
  const start = tokens.findIndex(
    (token) => !token.quoted && isPrismaBinary(basename(token.value))
  )
  if (start === -1) return null

  const words = tokens
    .slice(start + 1)
    .filter((token) => !token.value.startsWith('-'))
    .map((token) => token.value)
  const pushesSchema = words.some(
    (word, index) => word === 'db' && words[index + 1] === 'push'
  )
  if (!pushesSchema) return null

  return {
    decision: 'block',
    rule: 'schema-push',
    reason:
      '`prisma db push` writes the schema straight at the database, outside ' +
      'migration history — this run may never do that.',
    alternative:
      'Create a migration instead: `prisma migrate dev --name <name>`.'
  }
}

function isPrismaBinary(name: string): boolean {
  return name === 'prisma' || name.startsWith('prisma@')
}

/**
 * The command name inside a token, so a package-runner prefix, a
 * `node_modules/.bin` path, and a bare name all match the same rule.
 */
function basename(value: string): string {
  return value.split('/').pop() ?? value
}

/** Git's own options, before the subcommand, that take a separate value. */
const GIT_OPTIONS_WITH_VALUE = [
  '-C',
  '-c',
  '--git-dir',
  '--work-tree',
  '--namespace',
  '--exec-path'
]

/** Force-pushes and amends: the two ways a run could rewrite history. */
function classifyGit(tokens: Token[]): CommandVerdict | null {
  const git = readGitCommand(tokens)
  if (!git) return null

  const forced =
    git.flags.some(isForceFlag) ||
    // `git push origin +main` forces that ref with no flag at all.
    git.operands.some((operand) => operand.startsWith('+'))
  if (git.subcommand === 'push' && forced) {
    return {
      decision: 'block',
      rule: 'force-push',
      reason:
        'Force-pushing (a force flag or a leading-`+` refspec) rewrites the ' +
        'branch other tooling and reviewers have already read — this run may ' +
        'never do that.',
      alternative:
        'Make a new commit and push it normally; the branch is append-only.'
    }
  }

  if (git.subcommand === 'commit' && git.flags.includes('--amend')) {
    return {
      decision: 'block',
      rule: 'amend',
      reason:
        'Amending rewrites a commit that is already part of the run — this ' +
        'run may never do that.',
      alternative: 'Make a new commit with the follow-up change instead.'
    }
  }

  return null
}

function isForceFlag(flag: string): boolean {
  if (flag.startsWith('--')) {
    const name = flag.split('=')[0]
    return (
      name === '--force' ||
      name === '--force-with-lease' ||
      name === '--force-if-includes'
    )
  }
  // A short cluster: `-f`, and `-fu` the same as `-f -u`.
  return flag.slice(1).includes('f')
}

interface GitCommand {
  subcommand: string
  /** Every option token after the subcommand. */
  flags: string[]
  /** Every non-option token after the subcommand — remotes, refspecs, paths. */
  operands: string[]
}

/**
 * The git subcommand a segment runs, and the flags it passes — or null when
 * the segment isn't git at all. Git's own pre-subcommand options are stepped
 * over, including the ones whose value is a separate word (`git -C /repo …`).
 */
function readGitCommand(tokens: Token[]): GitCommand | null {
  const start = tokens.findIndex(
    (token) => !token.quoted && basename(token.value) === 'git'
  )
  if (start === -1) return null

  let index = start + 1
  while (index < tokens.length && tokens[index].value.startsWith('-')) {
    const flag = tokens[index].value
    index += GIT_OPTIONS_WITH_VALUE.includes(flag) ? 2 : 1
  }

  const subcommand = tokens[index]
  if (!subcommand || subcommand.quoted) return null

  const rest = tokens.slice(index + 1).filter((token) => !token.quoted)

  return {
    subcommand: subcommand.value,
    flags: rest
      .filter((token) => token.value.startsWith('-'))
      .map((token) => token.value),
    operands: rest
      .filter((token) => !token.value.startsWith('-'))
      .map((token) => token.value)
  }
}
