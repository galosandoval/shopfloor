import { createLineReader } from './lines'

/** Collects what a reader emitted, which is the whole of its observable output. */
function collect(chunks: string[], maxLineChars = 1_000) {
  const lines: string[] = []
  const reader = createLineReader({
    maxLineChars,
    onLine: (line) => lines.push(line)
  })
  for (const chunk of chunks) reader.push(chunk)
  return { lines, reader }
}

describe('createLineReader', () => {
  it('emits whole lines across chunk boundaries', () => {
    const { lines } = collect(['one\ntw', 'o\nthree\n'])

    expect(lines).toEqual(['one', 'two', 'three'])
  })

  it('holds a final line that arrived without a newline', () => {
    const { lines, reader } = collect(['done\nhalf'])

    expect(lines).toEqual(['done'])
    expect(reader.pending()).toBe('half')
  })

  it('drops a line too long to hold and resyncs to the next one', () => {
    const { lines, reader } = collect(['x'.repeat(20), 'more\nafter\n'], 10)

    expect(lines).toEqual(['after'])
    expect(reader.pending()).toBe('')
  })

  it('keeps at most one partial line in memory', () => {
    const { reader } = collect(['a\n'.repeat(500), 'tail'])

    expect(reader.buffered()).toBe('tail'.length)
  })
})
