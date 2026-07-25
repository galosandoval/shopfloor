import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { captureTranscript, findNewestSessionFile } from './transcript'

let workdir: string

beforeEach(() => {
  workdir = fs.mkdtempSync(path.join(os.tmpdir(), 'transcript-test-'))
})

afterEach(() => {
  fs.rmSync(workdir, { recursive: true, force: true })
})

/** Write a JSONL session file under `projectsDir/<encoded-cwd>/<id>.jsonl`. */
function writeSession(
  projectsDir: string,
  encoded: string,
  id: string
): string {
  const dir = path.join(projectsDir, encoded)
  fs.mkdirSync(dir, { recursive: true })
  const file = path.join(dir, `${id}.jsonl`)
  fs.writeFileSync(file, `{"sessionId":"${id}"}\n`)
  return file
}

describe('findNewestSessionFile', () => {
  it('returns the most recently modified JSONL across nested project dirs', () => {
    const projectsDir = path.join(workdir, 'projects')
    const older = writeSession(projectsDir, '-repo-a', 'old')
    const newer = writeSession(projectsDir, '-repo-b', 'new')
    // Make `older` strictly older so mtime ordering is unambiguous.
    fs.utimesSync(older, new Date(1000), new Date(1000))
    fs.utimesSync(newer, new Date(2000), new Date(2000))

    expect(findNewestSessionFile(projectsDir)).toBe(newer)
  })

  it('ignores non-JSONL files', () => {
    const projectsDir = path.join(workdir, 'projects')
    const session = writeSession(projectsDir, '-repo', 'sess')
    const dir = path.dirname(session)
    const noise = path.join(dir, 'notes.txt')
    fs.writeFileSync(noise, 'not a session')
    fs.utimesSync(session, new Date(1000), new Date(1000))
    fs.utimesSync(noise, new Date(5000), new Date(5000))

    expect(findNewestSessionFile(projectsDir)).toBe(session)
  })

  it('returns undefined when the directory is absent', () => {
    expect(findNewestSessionFile(path.join(workdir, 'missing'))).toBeUndefined()
  })

  it('returns undefined when no JSONL files exist', () => {
    const projectsDir = path.join(workdir, 'projects')
    fs.mkdirSync(projectsDir, { recursive: true })
    expect(findNewestSessionFile(projectsDir)).toBeUndefined()
  })
})

describe('captureTranscript', () => {
  it('copies the newest session under projectsDir to the destination', () => {
    const projectsDir = path.join(workdir, 'projects')
    const session = writeSession(projectsDir, '-repo', 'sess')
    const dest = path.join(workdir, 'transcript.jsonl')

    expect(captureTranscript({ projectsDir, destPath: dest })).toBe(true)
    expect(fs.readFileSync(dest, 'utf8')).toBe(fs.readFileSync(session, 'utf8'))
  })

  it('returns false when no transcript can be found', () => {
    const dest = path.join(workdir, 'transcript.jsonl')
    expect(
      captureTranscript({
        projectsDir: path.join(workdir, 'missing'),
        destPath: dest
      })
    ).toBe(false)
    expect(fs.existsSync(dest)).toBe(false)
  })

  it('never throws when the destination is unwritable', () => {
    const projectsDir = path.join(workdir, 'projects')
    writeSession(projectsDir, '-repo', 'sess')
    // A directory path as destination makes copyFileSync throw internally.
    const dest = path.join(workdir, 'a-directory')
    fs.mkdirSync(dest)

    expect(captureTranscript({ projectsDir, destPath: dest })).toBe(false)
  })
})
