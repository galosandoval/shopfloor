import * as fs from 'node:fs'
import * as path from 'node:path'

/**
 * Locate the most recently modified Claude Code session JSONL under
 * `projectsDir` (the `$HOME/.claude/projects/<encoded-cwd>/<id>.jsonl` tree).
 *
 * The Claude CLI doesn't report its own session path, so this is how
 * {@link captureTranscript} finds it — on an ephemeral CI runner (or a single
 * local run) there is exactly one session, so "newest JSONL" resolves it
 * unambiguously. Best-effort: returns undefined and never throws when the
 * tree is missing or holds no `.jsonl` files.
 */
export function findNewestSessionFile(projectsDir: string): string | undefined {
  let newest: { path: string; mtimeMs: number } | undefined
  const stack = [projectsDir]
  try {
    while (stack.length > 0) {
      const dir = stack.pop()
      if (dir === undefined) continue
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name)
        if (entry.isDirectory()) {
          stack.push(full)
        } else if (entry.isFile() && entry.name.endsWith('.jsonl')) {
          const { mtimeMs } = fs.statSync(full)
          if (!newest || mtimeMs > newest.mtimeMs) {
            newest = { path: full, mtimeMs }
          }
        }
      }
    }
  } catch {
    // Best-effort: a missing/unreadable tree just yields whatever we found.
  }
  return newest?.path
}

/**
 * Copy the agent's session transcript (the newest JSONL under `projectsDir`)
 * to `destPath`, best-effort. Returns true when a transcript was written.
 * Never throws — transcript capture is observability only and must never
 * fail an otherwise-green implement run.
 */
export function captureTranscript(opts: {
  projectsDir: string
  destPath: string
}): boolean {
  const source = findNewestSessionFile(opts.projectsDir)
  if (!source) return false
  try {
    fs.copyFileSync(source, opts.destPath)
    return true
  } catch {
    return false
  }
}
