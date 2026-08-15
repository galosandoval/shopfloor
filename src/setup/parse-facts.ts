/**
 * Reading the raw output the doctor's probes collect — `gh auth status`, a
 * workflow's `on:` block, a prompt template — into the shapes
 * {@link evaluateSetup} judges. Pure, and split from `setup.ts` for the reason
 * that file would otherwise change for two: the check vocabulary is this
 * package's, while these formats belong to GitHub and to the consumer's
 * prompt, and they move on their own schedule.
 */

/** Every `{{TOKEN}}` a prompt template carries, deduplicated. */
export function promptTokensIn(template: string): string[] {
  const found = template.match(/\{\{\s*[A-Z0-9_]+\s*\}\}/g) ?? []
  return [...new Set(found.map((token) => token.replace(/[{}\s]/g, '')))]
}

/**
 * What sits between the environment fences, or null when the prompt carries
 * no block — an unterminated opening fence included, which is not a block that
 * can be judged filled or empty.
 */
export function environmentBlockBody(
  template: string,
  start: string,
  end: string
): string | null {
  const opens = template.indexOf(start)
  if (opens === -1) return null
  const from = opens + start.length
  const closes = template.indexOf(end, from)
  return closes === -1 ? null : template.slice(from, closes)
}

/** A workflow's `on:` block, flattened to what the setup checks ask of it. */
export interface WorkflowTriggers {
  /**
   * Every event the workflow declares, mapped to the `types:` it filters on.
   * An event that declares none maps to `undefined`, which is GitHub's own
   * meaning — every activity type that event carries — and not "none".
   */
  events: Record<string, string[] | undefined>
  /** The `workflows:` a `workflow_run` trigger names, verbatim. */
  workflowRunSources: string[]
}

/** Whether a workflow fires on one event and activity type. */
export function firesOn(
  triggers: WorkflowTriggers,
  event: string,
  type: string
): boolean {
  if (!(event in triggers.events)) return false
  const types = triggers.events[event]
  return types === undefined || types.includes(type)
}

/**
 * The `on:` block of a workflow, read shallowly.
 *
 * **Deliberately not a YAML parser.** Adding a YAML dependency to read one
 * block would put a second, fuller model of the file in the package than the
 * question needs. This reads the two levels the trigger wiring lives at and
 * treats anything it cannot read as **absent** — which surfaces as a named
 * check failure a human can see, never as a silent pass. That direction is the
 * whole licence for the shortcut: the shallow scan can cost a correct setup a
 * false report, and can never bless a wrong one.
 */
export function parseTriggers(workflow: string): WorkflowTriggers {
  const events: Record<string, string[] | undefined> = {}
  const workflowRunSources: string[] = []

  /** Where the values of the key currently open get appended. */
  let collector: string[] | undefined
  let currentEvent: string | undefined
  let inOnBlock = false
  /** Indent the event names sit at — whatever the file's first one used. */
  let eventIndent: number | undefined

  const openKey = (event: string, key: string): string[] | undefined => {
    if (key === 'types') return (events[event] = [])
    if (key === 'workflows' && event === 'workflow_run') {
      return workflowRunSources
    }
    return undefined
  }

  for (const raw of workflow.split('\n')) {
    const line = raw.replace(/(^|\s)#.*$/, '').trimEnd()
    if (!line.trim()) continue

    const indent = line.length - line.trimStart().length
    const content = line.trim()

    if (indent === 0) {
      // `on:` is written `"on":` in files that dodge YAML reading the bare
      // word as a boolean, so both spellings count.
      inOnBlock = /^["']?on["']?:/.test(content)
      currentEvent = undefined
      collector = undefined
      eventIndent = undefined
      // `on: [issues, workflow_run]` — an inline list declares events and no types.
      const inline = content.match(/^["']?on["']?:\s*\[(.*)\]/)
      for (const event of splitInlineList(inline?.[1] ?? '')) {
        events[event] = undefined
      }
      continue
    }
    if (!inOnBlock) continue

    eventIndent ??= indent

    const entry = content.match(/^([A-Za-z_]+):\s*(.*)$/)
    if (entry) {
      const [, name, value] = entry
      if (indent <= eventIndent) {
        // An event name. One that declares no `types:` stays undefined, which
        // is GitHub's own meaning: it fires on every type the event carries.
        events[name] ??= undefined
        currentEvent = name
        collector = undefined
        continue
      }

      collector =
        currentEvent === undefined ? undefined : openKey(currentEvent, name)
      const inline = value?.match(/^\[(.*)\]$/)
      if (inline?.[1] !== undefined) {
        collector?.push(...splitInlineList(inline[1]))
        collector = undefined
      }
      continue
    }

    // A block-sequence item, belonging to whichever key opened above it.
    const item = content.match(/^-\s*(.+)$/)?.[1]
    if (item !== undefined) collector?.push(unquote(item))
  }

  return { events, workflowRunSources }
}

/** Scopes `gh auth status` reported, from its `Token scopes: 'a', 'b'` line. */
export function parseGhTokenScopes(output: string): string[] | 'unknown' {
  const marker = 'Token scopes:'
  const line = output
    .split('\n')
    .find((candidate) => candidate.includes(marker))
  if (!line) return 'unknown'
  const scopes = line
    .slice(line.indexOf(marker) + marker.length)
    .split(',')
    .map((scope) => unquote(scope.trim()))
    .filter(Boolean)
  return scopes.length > 0 ? scopes : 'unknown'
}

function splitInlineList(raw: string): string[] {
  return raw
    .split(',')
    .map((entry) => unquote(entry.trim()))
    .filter(Boolean)
}

function unquote(raw: string): string {
  return raw.replace(/^["']|["']$/g, '').trim()
}
