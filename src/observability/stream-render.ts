/**
 * The job log's half of the CLI's `stream-json` stdout: one readable line per
 * thing the agent did, in place of the raw JSONL a run used to print.
 *
 * The stream is on because the idle guard needs a heartbeat
 * (`prepareClaudeInvocation`), and `--include-partial-messages` makes that
 * heartbeat per-token — so the bytes reaching the job log were a wall of JSON
 * with every token's delta repeated in it. That log is the only place a human
 * watches a headless run, so the rendering is not cosmetic: unreadable output
 * is the same as no observability.
 *
 * **Nothing is lost by rendering.** The verbatim session record is captured
 * separately as the run's transcript artifact (`transcript.ts`), so this can
 * summarize freely; what it drops is duplication, not evidence.
 *
 * Pure, in the usual two halves: {@link renderStreamLine} turns one line into
 * the sentence for it or nothing, and {@link createStreamRenderer} is the
 * line-splitting adapter the spawn shell feeds bytes to. Like the usage meter
 * beside it, **unreadable degrades and never fails** — a line this module
 * cannot parse is printed as it arrived, so a stream that changed shape costs
 * readability rather than the run.
 */

import { asRecord } from '../json/record'
import { createLineReader } from './lines'

/**
 * How much of an unterminated line to hold. Lower than the usage meter's
 * ceiling on purpose: every line worth rendering is a message or a truncated
 * tool result, and one longer than this is a tool payload whose rendering
 * would have been cut to a couple of hundred characters anyway.
 */
const MAX_LINE_CHARS = 64_000

/** How much of an assistant's prose to print before cutting it. */
const MAX_TEXT_CHARS = 1_200

/** How much of a tool's arguments, or of a tool result, to print. */
const MAX_DETAIL_CHARS = 200

export interface StreamRenderer {
  /** Feed a chunk of decoded stdout; returns the text to write to the log. */
  push(chunk: string): string
  /** The text for a final line that arrived without a trailing newline. */
  end(): string
}

/**
 * A stateful adapter over {@link renderStreamLine}: bytes in at arbitrary
 * chunk boundaries, log text out. It holds one partial line and nothing else.
 */
export function createStreamRenderer(
  options: { maxLineChars?: number } = {}
): StreamRenderer {
  let out = ''
  const reader = createLineReader({
    maxLineChars: options.maxLineChars ?? MAX_LINE_CHARS,
    onLine: (line) => {
      const rendered = renderStreamLine(line)
      if (rendered) out += `${rendered}\n`
    }
  })

  return {
    push(chunk: string) {
      reader.push(chunk)
      const text = out
      out = ''
      return text
    },

    end() {
      const pending = reader.pending()
      if (!pending) return ''
      const rendered = renderStreamLine(pending)
      return rendered ? `${rendered}\n` : ''
    }
  }
}

/**
 * What one line of the stream should say in the job log, or undefined for the
 * lines that should say nothing — the per-token `stream_event`s, whose whole
 * content is repeated by the `assistant` event that follows them.
 *
 * A line that is not JSON is returned verbatim rather than dropped: the CLI
 * writes plain prose to stdout on some failures, and swallowing it would hide
 * exactly the output a human came to the log for.
 */
export function renderStreamLine(line: string): string | undefined {
  const trimmed = line.trim()
  if (!trimmed) return undefined

  const event = parseJsonObject(trimmed)
  if (!event) return line
  if (typeof event.type !== 'string') return undefined

  switch (event.type) {
    case 'system':
      return renderSystem(event)
    case 'assistant':
      return renderAssistant(event)
    case 'user':
      return renderToolResults(event)
    case 'result':
      return renderResult(event)
    default:
      // `stream_event` and anything else the CLI adds: silent by default, so a
      // new event type costs nothing rather than flooding the log.
      return undefined
  }
}

/** The session banner: what the run is about to spend a budget with. */
function renderSystem(event: Record<string, unknown>): string | undefined {
  if (event.subtype !== 'init') return undefined

  const facts = [
    typeof event.model === 'string' ? event.model : undefined,
    Array.isArray(event.tools) ? `${event.tools.length} tools` : undefined,
    typeof event.cwd === 'string' ? event.cwd : undefined
  ].filter((fact): fact is string => fact !== undefined)

  return `\n── session started${facts.length ? ` · ${facts.join(' · ')}` : ''}`
}

/** One assistant turn: its prose and the tool calls it made, a line each. */
function renderAssistant(event: Record<string, unknown>): string | undefined {
  const message = asRecord(event.message)
  const content = Array.isArray(message?.content) ? message.content : []

  const lines = content
    .map((block) => renderContentBlock(asRecord(block)))
    .filter((rendered): rendered is string => rendered !== undefined)

  return lines.length > 0 ? lines.join('\n') : undefined
}

function renderContentBlock(
  block: Record<string, unknown> | undefined
): string | undefined {
  if (!block) return undefined

  if (block.type === 'text' && typeof block.text === 'string') {
    const text = block.text.trim()
    return text ? `\n● ${indent(truncate(text, MAX_TEXT_CHARS))}` : undefined
  }

  // Thinking is summarized rather than printed: it is the longest content in a
  // stream and the least useful for answering "what is it doing right now".
  if (block.type === 'thinking' && typeof block.thinking === 'string') {
    return `  ✻ thinking (${block.thinking.length} chars)`
  }

  if (block.type === 'tool_use') {
    const name = typeof block.name === 'string' ? block.name : 'tool'
    return `  ⏺ ${name}(${summarizeToolInput(name, asRecord(block.input))})`
  }

  return undefined
}

/**
 * The argument of a tool call worth seeing at a glance. Keyed by tool so the
 * common ones read as the thing they are — a command, a path, a pattern —
 * with a generic fallback so a tool this table does not know still says
 * something rather than nothing.
 */
function summarizeToolInput(
  name: string,
  input: Record<string, unknown> | undefined
): string {
  if (!input) return ''

  const byTool: Record<string, string> = {
    Bash: 'command',
    Read: 'file_path',
    Write: 'file_path',
    Edit: 'file_path',
    NotebookEdit: 'notebook_path',
    Glob: 'pattern',
    Grep: 'pattern',
    Task: 'description',
    WebFetch: 'url',
    WebSearch: 'query',
    Skill: 'skill'
  }

  const preferred = byTool[name]
  const value = preferred === undefined ? undefined : input[preferred]
  if (typeof value === 'string')
    return oneLine(truncate(value, MAX_DETAIL_CHARS))

  const firstString = Object.values(input).find(
    (candidate): candidate is string => typeof candidate === 'string'
  )
  if (firstString !== undefined)
    return oneLine(truncate(firstString, MAX_DETAIL_CHARS))

  return Object.keys(input).join(', ')
}

/**
 * What came back from the tools, as the follow-up to the call above it. Only
 * tool results are rendered off a `user` event: the run's own prompt is the
 * other thing that arrives as one, and reprinting a multi-KB prompt into the
 * log is the problem this module exists to fix.
 */
function renderToolResults(event: Record<string, unknown>): string | undefined {
  const message = asRecord(event.message)
  const content = Array.isArray(message?.content) ? message.content : []

  const lines = content
    .map((entry) => asRecord(entry))
    .filter((block) => block?.type === 'tool_result')
    .map((block) => {
      const text = toolResultText(block?.content)
      const head = block?.is_error === true ? '↳ error:' : '↳'
      return text
        ? `    ${head} ${oneLine(truncate(text, MAX_DETAIL_CHARS))}`
        : `    ${head} (no output)`
    })

  return lines.length > 0 ? lines.join('\n') : undefined
}

/** A tool result's text, which the CLI sends either as a string or as blocks. */
function toolResultText(content: unknown): string {
  if (typeof content === 'string') return content.trim()
  if (!Array.isArray(content)) return ''

  return content
    .map((block) => asRecord(block))
    .map((block) => (typeof block?.text === 'string' ? block.text : ''))
    .join('\n')
    .trim()
}

/** The terminal event: how the session ended, and what it took to get there. */
function renderResult(event: Record<string, unknown>): string {
  const facts = [
    typeof event.subtype === 'string' ? event.subtype : undefined,
    typeof event.num_turns === 'number'
      ? `${event.num_turns} turns`
      : undefined,
    typeof event.duration_ms === 'number'
      ? formatDuration(event.duration_ms)
      : undefined,
    typeof event.total_cost_usd === 'number'
      ? `$${event.total_cost_usd.toFixed(4)}`
      : undefined
  ].filter((fact): fact is string => fact !== undefined)

  const outcome = event.is_error === true ? 'session failed' : 'session ended'
  return `\n── ${outcome}${facts.length ? ` · ${facts.join(' · ')}` : ''}\n`
}

/** `4m 12s`, or `12s` under a minute — a duration a human reads at a glance. */
function formatDuration(ms: number): string {
  const seconds = Math.round(ms / 1_000)
  if (seconds < 60) return `${seconds}s`
  return `${Math.floor(seconds / 60)}m ${seconds % 60}s`
}

/** Keeps a multi-line message under its bullet rather than at column zero. */
function indent(text: string): string {
  return text.split('\n').join('\n  ')
}

/** Collapses a value onto the one line it is printed on. */
function oneLine(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}

function truncate(text: string, max: number): string {
  return text.length <= max
    ? text
    : `${text.slice(0, max)}… (+${text.length - max} chars)`
}

/** One JSONL line as an object, or undefined — see {@link renderStreamLine}. */
function parseJsonObject(line: string): Record<string, unknown> | undefined {
  if (!line.startsWith('{')) return undefined
  try {
    return asRecord(JSON.parse(line))
  } catch {
    return undefined
  }
}
