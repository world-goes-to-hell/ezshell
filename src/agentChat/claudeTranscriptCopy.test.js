import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { copyClaudeTranscript } from './claudeTranscriptCopy.js'

const SESSION = '183a2d7a-c5d8-4d40-acd1-11c08bce7cde'
const CWD = 'D:\\DEV\\WORKSPACE\\PERSONAL\\my-ssh-client'
const FOLDER = 'D--DEV-WORKSPACE-PERSONAL-my-ssh-client'

let base, source, target
beforeEach(() => {
  base = fs.mkdtempSync(path.join(os.tmpdir(), 'ezshell-transcript-copy-'))
  source = path.join(base, 'source')
  target = path.join(base, 'target')
  fs.mkdirSync(path.join(source, 'projects', FOLDER, SESSION, 'tool-results'), { recursive: true })
  fs.writeFileSync(path.join(source, 'projects', FOLDER, SESSION + '.jsonl'), '{"type":"user"}\n')
  fs.writeFileSync(path.join(source, 'projects', FOLDER, SESSION, 'tool-results', 'a.txt'), 'result')
  fs.mkdirSync(target)
})
afterEach(() => fs.rmSync(base, { recursive: true, force: true }))

const copy = options => copyClaudeTranscript({ sourceRoot: source, targetRoot: target, sessionId: SESSION, cwd: CWD, now: 1000, ...options })
const inTarget = (...parts) => path.join(target, 'projects', FOLDER, ...parts)

describe('copyClaudeTranscript', () => {
  it('copies the transcript and its session folder to the same project folder of the other account', () => {
    expect(copy()).toEqual({ folder: FOLDER })
    expect(fs.readFileSync(inTarget(SESSION + '.jsonl'), 'utf8')).toBe('{"type":"user"}\n')
    expect(fs.readFileSync(inTarget(SESSION, 'tool-results', 'a.txt'), 'utf8')).toBe('result')
    // The source stays as it was
    expect(fs.existsSync(path.join(source, 'projects', FOLDER, SESSION + '.jsonl'))).toBe(true)
    expect(fs.readdirSync(inTarget()).sort()).toEqual([SESSION, SESSION + '.jsonl'])
  })

  it('copies a transcript without a session folder', () => {
    fs.rmSync(path.join(source, 'projects', FOLDER, SESSION), { recursive: true })
    copy()
    expect(fs.readdirSync(inTarget())).toEqual([SESSION + '.jsonl'])
  })

  it('finds the transcript in another project folder when the folder name is not the plain cwd encoding', () => {
    fs.renameSync(path.join(source, 'projects', FOLDER), path.join(source, 'projects', 'shortened-1a2b'))
    expect(copy()).toEqual({ folder: 'shortened-1a2b' })
    expect(fs.existsSync(path.join(target, 'projects', 'shortened-1a2b', SESSION + '.jsonl'))).toBe(true)
  })

  it('keeps an existing copy in the other account instead of overwriting it', () => {
    fs.mkdirSync(inTarget(SESSION), { recursive: true })
    fs.writeFileSync(inTarget(SESSION + '.jsonl'), 'older')
    copy()
    expect(fs.readFileSync(inTarget(SESSION + '.jsonl'), 'utf8')).toBe('{"type":"user"}\n')
    expect(fs.readFileSync(inTarget(`${SESSION}.jsonl.before-1000.bak`), 'utf8')).toBe('older')
    expect(fs.existsSync(inTarget(`${SESSION}.before-1000`))).toBe(true)
  })

  it.each([
    ['not a session ID', () => ({ sessionId: '../x' })],
    ['the same account folder', () => ({ targetRoot: source })],
    ['a relative source', () => ({ sourceRoot: 'source' })]
  ])('refuses %s', (_, options) => {
    expect(() => copy(options())).toThrow()
    expect(fs.existsSync(path.join(target, 'projects'))).toBe(false)
  })

  it('refuses when the transcript is missing', () => {
    fs.rmSync(path.join(source, 'projects', FOLDER, SESSION + '.jsonl'))
    expect(() => copy()).toThrow('대화 기록을 찾지 못했습니다.')
  })

  it('refuses when two project folders hold the same session and neither is the cwd', () => {
    for (const name of ['one', 'two']) {
      fs.mkdirSync(path.join(source, 'projects', name))
      fs.writeFileSync(path.join(source, 'projects', name, SESSION + '.jsonl'), '{}')
    }
    fs.rmSync(path.join(source, 'projects', FOLDER), { recursive: true })
    expect(() => copy()).toThrow('대화 기록을 찾지 못했습니다.')
  })

  it.skipIf(process.platform === 'win32' && !canLink())('refuses a linked project folder or transcript', () => {
    const outside = path.join(base, 'outside')
    fs.mkdirSync(outside)
    fs.writeFileSync(path.join(outside, SESSION + '.jsonl'), 'secret')
    fs.rmSync(path.join(source, 'projects', FOLDER), { recursive: true })
    fs.symlinkSync(outside, path.join(source, 'projects', FOLDER), 'junction')
    expect(() => copy()).toThrow()
    expect(fs.existsSync(inTarget(SESSION + '.jsonl'))).toBe(false)
  })

  it('refuses a linked target projects folder', () => {
    const outside = path.join(base, 'outside')
    fs.mkdirSync(outside)
    fs.symlinkSync(outside, path.join(target, 'projects'), 'junction')
    expect(() => copy()).toThrow()
    expect(fs.readdirSync(outside)).toEqual([])
  })
})

function canLink() {
  const probe = fs.mkdtempSync(path.join(os.tmpdir(), 'ezshell-link-probe-'))
  try {
    fs.mkdirSync(path.join(probe, 'a'))
    fs.symlinkSync(path.join(probe, 'a'), path.join(probe, 'b'), 'junction')
    return true
  } catch { return false } finally { fs.rmSync(probe, { recursive: true, force: true }) }
}
