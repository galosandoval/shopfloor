/**
 * The removed bin refuses (shopfloor#51). What it alone owns is the exit code
 * and that the sentence names its replacement — a shim that exited zero would
 * be a workflow step that passes while running nothing.
 */

let exitCodes: number[]
let printed: string[]

beforeEach(() => {
  exitCodes = []
  printed = []

  vi.resetModules()
  vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
    exitCodes.push(code ?? 0)
    return undefined as never
  }) as typeof process.exit)
  vi.spyOn(console, 'error').mockImplementation((line: string) => {
    printed.push(line)
  })
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('shopfloor-implement', () => {
  it('exits non-zero and names the bin that replaced it', async () => {
    await import('./implement-cli')

    expect(exitCodes).toEqual([1])
    expect(printed.join('\n')).toContain('shopfloor-run-phase')
    expect(printed.join('\n')).toContain('GITHUB_EVENT_PATH')
  })
})
