/**
 * Fixtures here are **recorded**, not invented: every line marked as such was
 * captured verbatim from `claude --print --output-format stream-json --verbose
 * --include-partial-messages`, which is the exact invocation
 * `prepareClaudeInvocation` assembles. A hand-written shape would only assert
 * that this module parses what its author imagined the CLI emits.
 */

import {
  accumulateUsage,
  createStreamUsageReader,
  emptyUsageAccumulator,
  mergeRunUsage,
  parseUsageEvent,
  summarizeUsage,
  type RunUsage
} from './usage'

/** Recorded: the terminal `result` event, the CLI's own tally for the session. */
const RESULT_LINE =
  '{"is_error":false,"duration_api_ms":2197,"num_turns":1,"session_id":"81f73fc3","total_cost_usd":0.0776655,"usage":{"input_tokens":2,"cache_creation_input_tokens":6930,"cache_read_input_tokens":16011,"output_tokens":14,"service_tier":"standard"},"subtype":"success","type":"result","result":"Hi!","duration_ms":2743}'

/** Recorded: an `assistant` event, carrying that message's own usage. */
const ASSISTANT_LINE =
  '{"type":"assistant","message":{"model":"claude-opus-5","id":"msg_011Ce5","role":"assistant","content":[{"type":"text","text":"Hi!"}],"usage":{"input_tokens":2,"cache_creation_input_tokens":6930,"cache_read_input_tokens":16011,"output_tokens":5}},"session_id":"81f73fc3"}'

/**
 * Recorded: a partial-message `stream_event`. It repeats the same message's
 * usage a second time, which is why it must never be counted.
 */
const STREAM_EVENT_LINE =
  '{"type":"stream_event","event":{"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"input_tokens":2,"cache_creation_input_tokens":6930,"cache_read_input_tokens":16011,"output_tokens":14}},"session_id":"81f73fc3"}'

/** Recorded: the session banner, the first line of every stream. */
const INIT_LINE =
  '{"type":"system","subtype":"init","cwd":"/tmp","session_id":"81f73fc3","tools":["Bash"],"model":"claude-opus-5","permissionMode":"default"}'

/** Folds a whole recorded stream, in order, the way the reader does. */
function fold(lines: string[]) {
  return lines.reduce((acc, line) => {
    const event = parseUsageEvent(line)
    return event ? accumulateUsage(acc, event) : acc
  }, emptyUsageAccumulator())
}

describe('parseUsageEvent', () => {
  it('reads the session tally and cost off a result event', () => {
    expect(parseUsageEvent(RESULT_LINE)).toEqual({
      kind: 'result',
      costUsd: 0.0776655,
      usage: {
        inputTokens: 2,
        outputTokens: 14,
        cacheCreationInputTokens: 6930,
        cacheReadInputTokens: 16011
      }
    })
  })

  it('reads one message worth of usage off an assistant event', () => {
    expect(parseUsageEvent(ASSISTANT_LINE)).toEqual({
      kind: 'message',
      usage: {
        inputTokens: 2,
        outputTokens: 5,
        cacheCreationInputTokens: 6930,
        cacheReadInputTokens: 16011
      }
    })
  })

  it('ignores the partial-message events that restate a message it already counted', () => {
    expect(parseUsageEvent(STREAM_EVENT_LINE)).toBeUndefined()
  })

  it('ignores events that carry no usage', () => {
    expect(parseUsageEvent(INIT_LINE)).toBeUndefined()
  })

  describe('degrading rather than throwing', () => {
    const unreadable: [string, string][] = [
      ['malformed JSON', '{"type":"result","usage":{'],
      ['a truncated line', '{"type":"assis'],
      ['a blank line', ''],
      ['plain text the CLI printed', 'Loading plugins...'],
      ['a JSON scalar', '42'],
      ['a JSON array', '[{"type":"result"}]'],
      ['usage of the wrong shape', '{"type":"result","usage":"lots"}'],
      [
        'token counts that are not numbers',
        '{"type":"assistant","message":{"usage":{"input_tokens":"2"}}}'
      ]
    ]

    it.each(unreadable)('returns undefined for %s', (_label, line) => {
      expect(parseUsageEvent(line)).toBeUndefined()
    })
  })

  it('keeps a partially readable event, defaulting the buckets it cannot read', () => {
    expect(
      parseUsageEvent('{"type":"result","usage":{"output_tokens":14}}')
    ).toEqual({
      kind: 'result',
      usage: {
        inputTokens: 0,
        outputTokens: 14,
        cacheCreationInputTokens: 0,
        cacheReadInputTokens: 0
      }
    })
  })

  it('leaves cost undefined when the stream reported none', () => {
    expect(
      parseUsageEvent('{"type":"result","usage":{"output_tokens":14}}')
    ).toEqual(expect.objectContaining({ costUsd: undefined }))
  })
})

describe('accumulateUsage', () => {
  it('sums assistant messages into the observed total', () => {
    const acc = fold([ASSISTANT_LINE, ASSISTANT_LINE, ASSISTANT_LINE])

    expect(summarizeUsage(acc)).toEqual({
      inputTokens: 6,
      outputTokens: 15,
      cacheCreationInputTokens: 20790,
      cacheReadInputTokens: 48033,
      costUsd: undefined,
      source: 'observed'
    })
  })

  it('prefers the CLI tally over its own sum, so a stream is never counted twice', () => {
    const acc = fold([
      INIT_LINE,
      ASSISTANT_LINE,
      STREAM_EVENT_LINE,
      RESULT_LINE
    ])

    expect(summarizeUsage(acc)).toEqual({
      inputTokens: 2,
      outputTokens: 14,
      cacheCreationInputTokens: 6930,
      cacheReadInputTokens: 16011,
      costUsd: 0.0776655,
      source: 'reported'
    })
  })

  it('reports what it saw when the run ended before its result event', () => {
    const acc = fold([INIT_LINE, ASSISTANT_LINE, STREAM_EVENT_LINE])

    expect(summarizeUsage(acc)).toEqual(
      expect.objectContaining({ outputTokens: 5, source: 'observed' })
    )
  })

  it('reports zeroes rather than nothing for a stream that said nothing about usage', () => {
    expect(summarizeUsage(fold([INIT_LINE, 'garbage']))).toEqual({
      inputTokens: 0,
      outputTokens: 0,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 0,
      costUsd: undefined,
      source: 'observed'
    })
  })

  it('reports no cost alongside an observed count, even were the stream to state one', () => {
    // A whole session's price beside a partial token count is the misreading
    // `source` exists to prevent, so the observed branch drops the cost.
    const acc = { ...fold([ASSISTANT_LINE]), costUsd: 0.5 }

    expect(summarizeUsage(acc)).toEqual(
      expect.objectContaining({ costUsd: undefined, source: 'observed' })
    )
  })

  it('does not mutate the accumulator it folds over', () => {
    const before = emptyUsageAccumulator()
    accumulateUsage(before, parseUsageEvent(RESULT_LINE)!)

    expect(before).toEqual(emptyUsageAccumulator())
  })
})

describe('mergeRunUsage', () => {
  const reported: RunUsage = {
    inputTokens: 1,
    outputTokens: 2,
    cacheCreationInputTokens: 3,
    cacheReadInputTokens: 4,
    costUsd: 0.5,
    source: 'reported'
  }

  it('sums the tokens and the cost of two iterations', () => {
    expect(mergeRunUsage(reported, reported)).toEqual({
      inputTokens: 2,
      outputTokens: 4,
      cacheCreationInputTokens: 6,
      cacheReadInputTokens: 8,
      costUsd: 1,
      source: 'reported'
    })
  })

  it('carries the cost of the iterations that reported one', () => {
    const noCost: RunUsage = { ...reported, costUsd: undefined }

    expect(mergeRunUsage(reported, noCost).costUsd).toBe(0.5)
  })

  it('leaves cost undefined when neither iteration reported one', () => {
    const noCost: RunUsage = { ...reported, costUsd: undefined }

    expect(mergeRunUsage(noCost, noCost).costUsd).toBeUndefined()
  })

  it('degrades the whole run to observed when any iteration only observed', () => {
    const observed: RunUsage = { ...reported, source: 'observed' }

    expect(mergeRunUsage(reported, observed).source).toBe('observed')
  })

  it('drops the cost of a degraded run even where an iteration reported one', () => {
    const observed: RunUsage = { ...reported, source: 'observed' }

    expect(mergeRunUsage(reported, observed).costUsd).toBeUndefined()
  })
})

describe('createStreamUsageReader', () => {
  it('totals a stream fed one whole line at a time', () => {
    const reader = createStreamUsageReader()
    for (const line of [INIT_LINE, ASSISTANT_LINE, RESULT_LINE]) {
      reader.push(`${line}\n`)
    }

    expect(reader.usage()).toEqual(
      expect.objectContaining({ outputTokens: 14, source: 'reported' })
    )
  })

  it('totals the same stream arriving in chunks that split lines anywhere', () => {
    const stream = [INIT_LINE, ASSISTANT_LINE, RESULT_LINE].join('\n') + '\n'
    const reader = createStreamUsageReader()
    for (let i = 0; i < stream.length; i += 7) {
      reader.push(stream.slice(i, i + 7))
    }

    expect(reader.usage()).toEqual(
      expect.objectContaining({ outputTokens: 14, source: 'reported' })
    )
  })

  it('counts a final line the stream never terminated with a newline', () => {
    const reader = createStreamUsageReader()
    reader.push(`${ASSISTANT_LINE}\n${RESULT_LINE}`)

    expect(reader.usage()).toEqual(
      expect.objectContaining({ outputTokens: 14, source: 'reported' })
    )
  })

  it('resyncs at the next newline after a line too long to buffer', () => {
    const reader = createStreamUsageReader({ maxLineChars: 64 })
    reader.push(`{"type":"user","message":"${'x'.repeat(500)}"}\n`)
    reader.push(`${RESULT_LINE}\n`)

    expect(reader.usage()).toEqual(
      expect.objectContaining({ outputTokens: 14, source: 'reported' })
    )
  })

  it('holds no more than the current line, however long the stream is', () => {
    const reader = createStreamUsageReader({ maxLineChars: 64 })
    for (let i = 0; i < 1000; i += 1) reader.push(`${ASSISTANT_LINE}\n`)

    expect(reader.buffered()).toBe(0)
  })

  it('survives a stream that is not JSON at all', () => {
    const reader = createStreamUsageReader()
    reader.push('claude: command produced no structured output\n')

    expect(reader.usage()).toEqual(
      expect.objectContaining({ outputTokens: 0, source: 'observed' })
    )
  })
})
