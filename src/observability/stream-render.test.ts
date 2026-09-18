/**
 * Fixtures here are **recorded**: the `system`, `assistant`, `stream_event`
 * and `result` lines are the same ones `usage.test.ts` folds, captured from
 * `claude --print --output-format stream-json --verbose
 * --include-partial-messages`, and the `tool_use` / `tool_result` blocks were
 * lifted verbatim out of a session transcript — the CLI streams the same
 * message shapes it records.
 */

import { createStreamRenderer, renderStreamLine } from './stream-render'

/** Recorded: the session banner, the first line of every stream. */
const INIT_LINE =
  '{"type":"system","subtype":"init","cwd":"/tmp","session_id":"81f73fc3","tools":["Bash","Read"],"model":"claude-opus-5","permissionMode":"default"}'

/** Recorded: an `assistant` event carrying the model's prose. */
const TEXT_LINE =
  '{"type":"assistant","message":{"model":"claude-opus-5","id":"msg_011Ce5","role":"assistant","content":[{"type":"text","text":"Reading the config first."}],"usage":{"input_tokens":2,"output_tokens":5}},"session_id":"81f73fc3"}'

/** Recorded: an `assistant` event whose content is a tool call. */
const TOOL_USE_LINE =
  '{"type":"assistant","message":{"model":"claude-opus-5","id":"msg_011Cf2","role":"assistant","content":[{"type":"tool_use","id":"toolu_01UWPY","name":"Bash","input":{"command":"grep -rli \\"playwright\\" . | head -50","description":"Find playwright references"}}],"usage":{"input_tokens":2,"output_tokens":5}},"session_id":"81f73fc3"}'

/** Recorded: the `user` event the CLI sends back with a tool's output. */
const TOOL_RESULT_LINE =
  '{"type":"user","message":{"role":"user","content":[{"tool_use_id":"toolu_01UWPY","type":"tool_result","content":"CONTEXT.md\\nREADME.md","is_error":false}]},"session_id":"81f73fc3"}'

/** Recorded: a tool call that failed. */
const TOOL_ERROR_LINE =
  '{"type":"user","message":{"role":"user","content":[{"tool_use_id":"toolu_01UWPY","type":"tool_result","content":"npm error missing script: tset","is_error":true}]},"session_id":"81f73fc3"}'

/** Recorded: a partial-message `stream_event` — one of thousands per run. */
const STREAM_EVENT_LINE =
  '{"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"text_delta","text":"Read"}},"session_id":"81f73fc3"}'

/** Recorded: the terminal `result` event. */
const RESULT_LINE =
  '{"is_error":false,"duration_api_ms":2197,"num_turns":18,"session_id":"81f73fc3","total_cost_usd":0.0776655,"usage":{"input_tokens":2,"output_tokens":14},"subtype":"success","type":"result","result":"Hi!","duration_ms":252743}'

describe('renderStreamLine', () => {
  it('names the session the run is about to spend a budget with', () => {
    expect(renderStreamLine(INIT_LINE)).toContain(
      'session started · claude-opus-5 · 2 tools · /tmp'
    )
  })

  it("prints the model's prose", () => {
    expect(renderStreamLine(TEXT_LINE)).toBe('\n● Reading the config first.')
  })

  it('names a tool call by the argument worth seeing', () => {
    expect(renderStreamLine(TOOL_USE_LINE)).toBe(
      '  ⏺ Bash(grep -rli "playwright" . | head -50)'
    )
  })

  it("puts a tool's output on one line under it", () => {
    expect(renderStreamLine(TOOL_RESULT_LINE)).toBe(
      '    ↳ CONTEXT.md README.md'
    )
  })

  it('marks a failed tool call as an error', () => {
    expect(renderStreamLine(TOOL_ERROR_LINE)).toBe(
      '    ↳ error: npm error missing script: tset'
    )
  })

  it('says nothing for the per-token partial messages', () => {
    expect(renderStreamLine(STREAM_EVENT_LINE)).toBeUndefined()
  })

  it('ends with how the session went and what it took', () => {
    expect(renderStreamLine(RESULT_LINE)).toContain(
      'session ended · success · 18 turns · 4m 13s · $0.0777'
    )
  })

  it('reports a failed session as one', () => {
    const failed = RESULT_LINE.replace('"is_error":false', '"is_error":true')

    expect(renderStreamLine(failed)).toContain('session failed')
  })

  it('bounds a long tool argument rather than printing the payload', () => {
    const long = JSON.stringify({
      type: 'assistant',
      message: {
        role: 'assistant',
        content: [
          {
            type: 'tool_use',
            name: 'Write',
            input: { file_path: 'x'.repeat(900) }
          }
        ]
      }
    })

    const rendered = renderStreamLine(long) ?? ''
    expect(rendered.length).toBeLessThan(300)
    expect(rendered).toContain('(+700 chars)')
  })

  it('summarizes thinking instead of printing it', () => {
    const thinking = JSON.stringify({
      type: 'assistant',
      message: {
        role: 'assistant',
        content: [{ type: 'thinking', thinking: 'weighing two options' }]
      }
    })

    expect(renderStreamLine(thinking)).toBe('  ✻ thinking (20 chars)')
  })

  it('passes prose the CLI wrote outside the stream through untouched', () => {
    expect(renderStreamLine('Invalid API key · Please run /login')).toBe(
      'Invalid API key · Please run /login'
    )
  })

  it('says nothing for an event type it does not know', () => {
    expect(
      renderStreamLine('{"type":"something_new","payload":{}}')
    ).toBeUndefined()
  })
})

describe('createStreamRenderer', () => {
  it('renders across chunk boundaries and drops the noise', () => {
    const renderer = createStreamRenderer()
    const stream = [INIT_LINE, STREAM_EVENT_LINE, TEXT_LINE].join('\n') + '\n'

    const out =
      renderer.push(stream.slice(0, 120)) +
      renderer.push(stream.slice(120)) +
      renderer.end()

    expect(out).toContain('session started')
    expect(out).toContain('● Reading the config first.')
    expect(out).not.toContain('stream_event')
  })

  it('renders a final line that arrived without a trailing newline', () => {
    const renderer = createStreamRenderer()

    expect(renderer.push(RESULT_LINE)).toBe('')
    expect(renderer.end()).toContain('session ended')
  })

  it('drops a line too long to hold rather than buffering a payload', () => {
    const renderer = createStreamRenderer({ maxLineChars: 100 })

    renderer.push(`{"type":"user","content":"${'x'.repeat(500)}"}\n`)
    expect(renderer.push(`${TEXT_LINE}\n`)).toContain('● Reading')
  })
})
