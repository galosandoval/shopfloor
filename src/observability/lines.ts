/**
 * The line splitter two readers over the CLI's `stream-json` stdout share: the
 * usage meter (`usage.ts`) and the job-log renderer (`stream-render.ts`). Its
 * own module because it is now used twice, and two copies would be two ideas
 * of what happens to a line too long to hold (`docs/typescript-style.md`).
 *
 * Stateful but not a shell: bytes in at arbitrary chunk boundaries, whole
 * lines out. Nothing here opens a file, spawns anything, or reads a clock.
 */

export interface LineReaderOptions {
  /** How much of an unterminated line to hold before giving up on it. */
  maxLineChars: number
  /** Called once per complete line, without its newline. */
  onLine: (line: string) => void
}

export interface LineReader {
  /** Feed a chunk of decoded stdout, at whatever boundary it arrived on. */
  push(chunk: string): void
  /** The partial line still held, or '' — a stream can end without a newline. */
  pending(): string
  /** Characters currently held — the memory bound, which its test pins. */
  buffered(): number
}

/**
 * A reader that emits whole lines and holds at most one partial one.
 *
 * A line that outgrows `maxLineChars` is thrown away and the reader resyncs to
 * the next newline rather than emitting a fragment: an unbounded buffer would
 * quietly undo the whole reason the stream is parsed as it arrives — one tool
 * result reading a large file, and the ceiling is gone.
 */
export function createLineReader(options: LineReaderOptions): LineReader {
  const { maxLineChars, onLine } = options
  let buffer = ''
  // Set when a line outgrew the buffer: everything up to the next newline is
  // the tail of a line already thrown away.
  let resyncing = false

  return {
    push(chunk: string) {
      buffer += chunk
      let newline = buffer.indexOf('\n')
      while (newline !== -1) {
        const line = buffer.slice(0, newline)
        buffer = buffer.slice(newline + 1)
        if (resyncing) resyncing = false
        else onLine(line)
        newline = buffer.indexOf('\n')
      }

      if (buffer.length > maxLineChars) {
        buffer = ''
        resyncing = true
      }
    },

    pending() {
      return resyncing ? '' : buffer
    },

    buffered() {
      return buffer.length
    }
  }
}
