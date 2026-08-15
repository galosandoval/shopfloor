/**
 * What a run cost, read off the CLI's own `stream-json` output (shopfloor#42).
 * The stream already flows through this process — `prepareClaudeInvocation`
 * turns it on so the idle guard has a heartbeat to watch — and until now every
 * byte of it was written to the job log and dropped. So the harness bounded a
 * run by attempts and by wall-clock while saying nothing about the one budget
 * the inner loop actually multiplies: tokens.
 *
 * Pure, and in two halves the way every decision here is: {@link
 * parseUsageEvent} turns one line into an event or nothing, {@link
 * accumulateUsage} folds events into a total, and {@link
 * createStreamUsageReader} is the line-splitting adapter the spawn shell feeds
 * bytes to. Nothing in this file opens a file, spawns anything, or reads a
 * clock — the fixtures its tests fold are recorded lines, not mocks.
 *
 * **Unreadable degrades, it never fails.** A line this module cannot parse is
 * skipped and the run continues. This is a diagnostic, and the package's
 * general rule holds: a missing signal must not cause an outage. The one
 * guardrail that inverts that rule (`evaluateAuthorization`) does so because
 * its failure is financial *and adversarial*; a token count nobody can read is
 * neither.
 */

/** Token counts in the four buckets the CLI's stream reports them in. */
export interface TokenUsage {
  inputTokens: number
  outputTokens: number
  cacheCreationInputTokens: number
  cacheReadInputTokens: number
}

/**
 * A run's spend, as far as its stream said — the shape that lands on the run
 * result.
 */
export interface RunUsage extends TokenUsage {
  /**
   * USD, when the stream reported it. Only the terminal `result` event carries
   * a cost, so a run killed by a guard has tokens and no cost; on a flat-rate
   * OAuth token the number is what the work *would* have been billed at, which
   * is exactly what a spend argument needs.
   */
  costUsd?: number
  /**
   * Whether these are the CLI's own final tally (`reported`) or this package's
   * sum over the assistant messages it happened to see (`observed`).
   *
   * The distinction is load-bearing and not cosmetic: **an `observed` total is
   * not comparable to a reported one, and it is not uniformly a floor.** Each
   * bucket degrades differently, because an `assistant` event is one message's
   * snapshot rather than a share of a session:
   *
   * - `outputTokens` is a **floor**. The snapshot is taken when the message
   *   started, so it is short of that message's final count, and a run killed
   *   mid-message contributes nothing at all.
   * - `inputTokens` and `cacheReadInputTokens` are **neither bound**, and
   *   typically overshoot. Every turn re-sends the conversation, so each
   *   message restates the prefix the turns before it already reported;
   *   summing across N turns counts the same tokens up to N times, and a
   *   multi-turn run's observed input can exceed the CLI's own tally by a
   *   large multiple. Read them as a signal that work happened, not as a
   *   quantity.
   * - `cacheCreationInputTokens` is per-request, so it sums honestly and is a
   *   floor for the same reason `outputTokens` is.
   *
   * A consumer charting spend, or a future ceiling deciding whether to spawn
   * again, has to know which of the two it is holding — collapsing them would
   * let a killed run's partial count be read as its cost.
   */
  source: 'reported' | 'observed'
}

/** A stream line that said something about usage. */
export type UsageEvent =
  | { kind: 'message'; usage: TokenUsage }
  | { kind: 'result'; usage: TokenUsage; costUsd?: number }

/**
 * Both totals, kept apart until {@link summarizeUsage} picks one. Two channels
 * rather than one running sum because the stream states the same tokens more
 * than once — the CLI's `result` event is a tally of the very messages already
 * counted, so adding it would roughly double every number.
 */
export interface UsageAccumulator {
  /** Summed from `assistant` events: what this process watched go by. */
  observed: TokenUsage
  /** The CLI's own tally, present once the run reached its `result` event. */
  reported?: TokenUsage
  costUsd?: number
}

const NO_TOKENS: TokenUsage = {
  inputTokens: 0,
  outputTokens: 0,
  cacheCreationInputTokens: 0,
  cacheReadInputTokens: 0
}

export function emptyUsageAccumulator(): UsageAccumulator {
  return { observed: { ...NO_TOKENS } }
}

/**
 * The identity for {@link mergeRunUsage} — a run that has not spawned yet. Its
 * `source` is `reported` deliberately: a spend of nothing is fully accounted
 * for, and starting at `observed` would mark every run's total unreliable
 * before it had spent anything.
 */
export const NO_RUN_USAGE: RunUsage = { ...NO_TOKENS, source: 'reported' }

/**
 * The usage a single line of `stream-json` reports, or undefined for the many
 * lines that report none.
 *
 * Two event types are read and a third is deliberately ignored. `assistant`
 * events are the per-message usage, and `result` is the session tally. The
 * partial-message `stream_event`s carry usage too — `message_start` and
 * `message_delta` both do — and counting them would count the same message two
 * or three times over, so the recognizer is an allowlist of exactly the two
 * shapes rather than a search for a `usage` key.
 */
export function parseUsageEvent(line: string): UsageEvent | undefined {
  const event = parseJsonObject(line)
  if (!event) return undefined

  if (event.type === 'result') {
    const usage = readTokenUsage(event.usage)
    if (!usage) return undefined
    return { kind: 'result', usage, costUsd: readNumber(event.total_cost_usd) }
  }

  if (event.type === 'assistant') {
    const message = asRecord(event.message)
    const usage = message && readTokenUsage(message.usage)
    if (!usage) return undefined
    return { kind: 'message', usage }
  }

  return undefined
}

/** Folds one event into the running totals. Returns a new accumulator. */
export function accumulateUsage(
  acc: UsageAccumulator,
  event: UsageEvent
): UsageAccumulator {
  if (event.kind === 'message') {
    return { ...acc, observed: addTokens(acc.observed, event.usage) }
  }

  // A stream carries at most one `result`; a second would be a session this
  // module was never handed, so the last tally wins rather than being summed
  // into the first.
  return { ...acc, reported: event.usage, costUsd: event.costUsd }
}

/**
 * The totals to report: the CLI's own tally when the run produced one.
 *
 * The observed branch reports **no cost**, and not merely because a stream
 * without a `result` event never carried one. A cost is a whole session's,
 * while observed tokens are a per-message sum that no bucket makes comparable
 * to it ({@link RunUsage.source}) — pairing them would put a complete price
 * next to a count that is not one, which is the one reading `source` exists to
 * prevent.
 */
export function summarizeUsage(acc: UsageAccumulator): RunUsage {
  return acc.reported
    ? { ...acc.reported, costUsd: acc.costUsd, source: 'reported' }
    : { ...acc.observed, costUsd: undefined, source: 'observed' }
}

/**
 * Two spawns' spend as one run's. Iterations are separate sessions, each with
 * its own tally, so a run that iterated costs the sum — the whole point of
 * measuring a mechanism that multiplies spend by N.
 *
 * The source degrades to `observed` if either side did: a run is only fully
 * accounted for when every one of its spawns was, and a total that is part
 * tally and part per-message sum reads as neither. A degraded total drops the
 * cost the way
 * {@link summarizeUsage} does, and for the same reason — the cost an iteration
 * did report is that session's whole price, so keeping it beside a token count
 * missing another session's spend is the misreading `source` exists to prevent.
 */
export function mergeRunUsage(a: RunUsage, b: RunUsage): RunUsage {
  const source =
    a.source === 'reported' && b.source === 'reported' ? 'reported' : 'observed'

  const costUsd =
    source === 'observed' || (a.costUsd === undefined && b.costUsd === undefined)
      ? undefined
      : (a.costUsd ?? 0) + (b.costUsd ?? 0)

  return { ...addTokens(a, b), costUsd, source }
}

// --- The line reader ----------------------------------------------------------

export interface StreamUsageReaderOptions {
  /** {@link MAX_LINE_CHARS} for this reader — lowered only by tests. */
  maxLineChars?: number
}

export interface StreamUsageReader {
  /** Feed a chunk of the CLI's stdout, at whatever boundary it arrived on. */
  push(chunk: string): void
  /** The totals from everything fed so far, including an unterminated last line. */
  usage(): RunUsage
  /** Characters currently held — the memory bound, which its test pins. */
  buffered(): number
}

/**
 * How much of an unterminated line to hold before giving up on it. A stream is
 * parsed as it arrives precisely so a long run is not accumulated in memory, and
 * an unbounded line buffer would quietly restore that — one tool result reading
 * a large file, and the ceiling is gone. Every usage-bearing line is well under
 * this; a line that is not is a tool result, and dropping it costs a line that
 * was never going to be counted.
 */
const MAX_LINE_CHARS = 512_000

/**
 * A stateful adapter over the pure pair above: bytes in at arbitrary chunk
 * boundaries, totals out. It holds one partial line and nothing else.
 *
 * It lives here rather than inside `spawnClaude` so the chunk-splitting — the
 * part with the actual edge cases, a line split mid-token, a stream with no
 * trailing newline, a line too long to keep — is testable against recorded
 * fixtures instead of only against a real child process.
 */
export function createStreamUsageReader(
  options: StreamUsageReaderOptions = {}
): StreamUsageReader {
  const maxLineChars = options.maxLineChars ?? MAX_LINE_CHARS
  let acc = emptyUsageAccumulator()
  let buffer = ''
  // Set when a line outgrew the buffer: everything up to the next newline is
  // the tail of a line already thrown away, and parsing it would be parsing a
  // fragment.
  let resyncing = false

  const consume = (line: string) => {
    const event = parseUsageEvent(line)
    if (event) acc = accumulateUsage(acc, event)
  }

  return {
    push(chunk: string) {
      buffer += chunk
      let newline = buffer.indexOf('\n')
      while (newline !== -1) {
        const line = buffer.slice(0, newline)
        buffer = buffer.slice(newline + 1)
        if (resyncing) resyncing = false
        else consume(line)
        newline = buffer.indexOf('\n')
      }

      if (buffer.length > maxLineChars) {
        buffer = ''
        resyncing = true
      }
    },

    usage() {
      // The last line of a stream that ended without a newline is a real line,
      // and on a `result` event it is the only one that carries the cost.
      if (buffer && !resyncing) {
        const event = parseUsageEvent(buffer)
        if (event) return summarizeUsage(accumulateUsage(acc, event))
      }
      return summarizeUsage(acc)
    },

    buffered() {
      return buffer.length
    }
  }
}

// --- Reading the CLI's shapes -------------------------------------------------

function addTokens(a: TokenUsage, b: TokenUsage): TokenUsage {
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    cacheCreationInputTokens:
      a.cacheCreationInputTokens + b.cacheCreationInputTokens,
    cacheReadInputTokens: a.cacheReadInputTokens + b.cacheReadInputTokens
  }
}

/**
 * The four token buckets off a CLI `usage` object, or undefined when it holds
 * no readable count at all. Missing and unreadable buckets default to zero
 * rather than voiding the event, so a stream that adds or renames a field keeps
 * reporting the fields it did not change — but an object with nothing readable
 * in it is not usage, and reporting it as four zeroes would fabricate a
 * free message.
 */
function readTokenUsage(value: unknown): TokenUsage | undefined {
  const usage = asRecord(value)
  if (!usage) return undefined

  const counts = {
    inputTokens: readNumber(usage.input_tokens),
    outputTokens: readNumber(usage.output_tokens),
    cacheCreationInputTokens: readNumber(usage.cache_creation_input_tokens),
    cacheReadInputTokens: readNumber(usage.cache_read_input_tokens)
  }
  if (Object.values(counts).every((count) => count === undefined))
    return undefined

  return {
    inputTokens: counts.inputTokens ?? 0,
    outputTokens: counts.outputTokens ?? 0,
    cacheCreationInputTokens: counts.cacheCreationInputTokens ?? 0,
    cacheReadInputTokens: counts.cacheReadInputTokens ?? 0
  }
}

/** A finite number, or undefined for anything else the stream put there. */
function readNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

/** One JSONL line as an object, or undefined — malformed lines are skipped. */
function parseJsonObject(line: string): Record<string, unknown> | undefined {
  const trimmed = line.trim()
  // Cheap reject before the parse: most of a stream's bytes are text deltas,
  // and `JSON.parse` in a try/catch on every one of them is the hot path.
  if (!trimmed.startsWith('{')) return undefined
  try {
    return asRecord(JSON.parse(trimmed))
  } catch {
    return undefined
  }
}
