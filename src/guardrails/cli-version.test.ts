import {
  DEFAULT_CLI_VERSION_STRICTNESS,
  checkCliVersion,
  parseCliVersion,
  parseCliVersionStrictness
} from './cli-version'

describe('parseCliVersion', () => {
  it('reads the leading semver out of the CLI’s own output format', () => {
    expect(parseCliVersion('2.1.220 (Claude Code)')).toBe('2.1.220')
  })

  it('tolerates surrounding whitespace and a v prefix', () => {
    expect(parseCliVersion('  v2.1.220\n')).toBe('2.1.220')
  })

  it('reads a bare version', () => {
    expect(parseCliVersion('2.1.220')).toBe('2.1.220')
  })

  it.each([
    ['unset', undefined],
    ['empty', ''],
    ['prose', 'command not found: claude'],
    ['a version that leads with something else', 'Claude Code 2.1.220'],
    ['a partial version', '2.1']
  ])('returns undefined for %s', (_name, raw) => {
    expect(parseCliVersion(raw)).toBeUndefined()
  })
})

describe('parseCliVersionStrictness', () => {
  it.each(['warn', 'error', 'off'] as const)('reads %s', (level) => {
    expect(parseCliVersionStrictness(level)).toBe(level)
  })

  it('ignores case and surrounding whitespace', () => {
    expect(parseCliVersionStrictness(' ERROR ')).toBe('error')
  })

  it.each([
    ['unset', undefined],
    ['empty', ''],
    ['an unrecognized level', 'strict']
  ])('returns undefined for %s, so the caller keeps its default', (_name, raw) => {
    expect(parseCliVersionStrictness(raw)).toBeUndefined()
  })
})

describe('checkCliVersion', () => {
  const strictness = DEFAULT_CLI_VERSION_STRICTNESS

  it('matches an identical version', () => {
    expect(
      checkCliVersion({ running: '2.1.220 (Claude Code)', pinned: '2.1.220', strictness })
    ).toEqual({ status: 'match', blocking: false })
  })

  it('matches across a patch difference, which cannot move the CLI surface this harness reads', () => {
    expect(
      checkCliVersion({ running: '2.1.220 (Claude Code)', pinned: '2.1.208', strictness })
    ).toMatchObject({ status: 'match' })
  })

  it.each([
    ['a minor difference', '2.2.0'],
    ['a major difference', '3.1.220']
  ])('mismatches on %s', (_name, running) => {
    expect(checkCliVersion({ running, pinned: '2.1.220', strictness })).toMatchObject({
      status: 'mismatch'
    })
  })

  it('names both versions in the mismatch message', () => {
    expect(
      checkCliVersion({
        running: '3.1.220 (Claude Code)',
        pinned: '2.1.220',
        strictness
      })
    ).toMatchObject({
      message: expect.stringMatching(/3\.1\.220.*2\.1\.220/s)
    })
  })

  it('does not block a mismatch at the default strictness', () => {
    expect(
      checkCliVersion({ running: '3.1.220', pinned: '2.1.220', strictness })
    ).toMatchObject({ status: 'mismatch', blocking: false })
  })

  it('blocks a mismatch under error strictness', () => {
    expect(
      checkCliVersion({ running: '3.1.220', pinned: '2.1.220', strictness: 'error' })
    ).toMatchObject({ status: 'mismatch', blocking: true })
  })

  it('compares nothing under off strictness, even on a mismatch', () => {
    expect(
      checkCliVersion({ running: '3.1.220', pinned: '2.1.220', strictness: 'off' })
    ).toEqual({ status: 'unchecked', blocking: false })
  })

  it('records without comparing when no version is pinned', () => {
    expect(
      checkCliVersion({ running: '2.1.220', pinned: undefined, strictness: 'error' })
    ).toEqual({ status: 'unchecked', blocking: false })
  })

  it.each([
    ['the running version could not be read', undefined],
    ['the running version is unparseable', 'command not found: claude']
  ])('never blocks, or speaks, when %s', (_name, running) => {
    expect(
      checkCliVersion({ running, pinned: '2.1.220', strictness: 'error' })
    ).toEqual({ status: 'unchecked', blocking: false })
  })

  it('never blocks on an unparseable pin, which is the caller’s typo, not a drifted CLI', () => {
    expect(
      checkCliVersion({ running: '2.1.220', pinned: 'latest', strictness: 'error' })
    ).toMatchObject({ status: 'unchecked', blocking: false })
  })

  it('still says so on an unparseable pin, so the check does not go quiet', () => {
    expect(
      checkCliVersion({ running: '2.1.220', pinned: 'latest', strictness })
    ).toMatchObject({ message: expect.stringContaining('latest') })
  })

  it('says nothing when the pin is unreadable but the check was switched off', () => {
    expect(
      checkCliVersion({ running: '2.1.220', pinned: 'latest', strictness: 'off' })
    ).toEqual({ status: 'unchecked', blocking: false })
  })
})
