import { describe, it, expect, vi } from 'vitest'
import path from 'path'
import loggerModule from './sessionLogger.js'

const { createSessionLogger } = loggerModule

const DIR = 'C:\\Logs'
const at = new Date(2026, 9, 2, 9, 5, 7)
const first = path.join(DIR, '웹서버_20261002-090507.log')

/** A logger over in-memory files. `files` maps path → written text; `failWrite` makes every write throw. */
function setup({ failOpen = false, failWrite = false, flushMs = 5, createRecorder } = {}) {
  const files = new Map()
  const closed = []
  const stopped = []
  const state = { failWrite }
  const logger = createSessionLogger({
    dir: DIR,
    eol: '\n',
    flushMs,
    now: () => at,
    ensureDir: () => {},
    exists: (file) => files.has(file),
    openFile: (file) => {
      if (failOpen) throw new Error('EACCES')
      files.set(file, '')
      return {
        write: (text) => {
          if (state.failWrite) throw new Error('ENOSPC')
          files.set(file, files.get(file) + text)
        },
        close: () => closed.push(file)
      }
    },
    onStopped: (info) => stopped.push(info),
    ...(createRecorder ? { createRecorder } : {})
  })
  return { logger, files, closed, stopped, state }
}

describe('createSessionLogger', () => {
  it('writes a header, the recorded lines and a footer', async () => {
    const { logger, files, closed } = setup()
    expect(logger.start('s1', '웹서버')).toEqual({ success: true, filePath: first })
    logger.write('s1', '\x1b[32m$\x1b[0m ls\r\n')
    logger.write('s1', Buffer.from('a.txt\r\n'))
    expect(await logger.stop('s1')).toEqual({ success: true, filePath: first })
    expect(files.get(first)).toBe([
      '=== ezShell 세션 로그: 웹서버 | 시작 2026-10-02 09:05:07 ===',
      '$ ls',
      'a.txt',
      '=== 종료 2026-10-02 09:05:07 ===',
      ''
    ].join('\n'))
    expect(closed).toEqual([first])
  })

  it('ignores output for a session that is not being logged, before and after', async () => {
    const { logger, files } = setup()
    logger.write('s1', 'early\r\n')
    logger.start('s1', '웹서버')
    await logger.stop('s1')
    logger.write('s1', 'late\r\n')
    expect(files.get(first)).not.toContain('early')
    expect(files.get(first)).not.toContain('late')
    expect(logger.list()).toEqual([])
  })

  it('reports the same file when a session is started twice', () => {
    const { logger, files } = setup()
    logger.start('s1', '웹서버')
    expect(logger.start('s1', '다른 이름')).toEqual({ success: true, filePath: first })
    expect(files.size).toBe(1)
    expect(logger.list()).toEqual([{ sessionId: 's1', filePath: first }])
  })

  it('gives two logs started in the same second different files', () => {
    const { logger } = setup()
    logger.start('s1', '웹서버')
    expect(logger.start('s2', '웹서버').filePath).toBe(path.join(DIR, '웹서버_20261002-090507-2.log'))
  })

  it('reports a file that cannot be created, without logging', () => {
    const { logger } = setup({ failOpen: true })
    expect(logger.start('s1', '웹서버')).toEqual({ success: false, error: '로그 파일을 만들 수 없습니다.' })
    expect(logger.list()).toEqual([])
  })

  it('stops only the log when a write fails, and tells the window', async () => {
    const { logger, stopped, state, closed } = setup()
    logger.start('s1', '웹서버')
    state.failWrite = true
    expect(() => logger.write('s1', 'a\r\n')).not.toThrow()
    await vi.waitFor(() => expect(stopped).toHaveLength(1))
    expect(stopped[0]).toEqual({ sessionId: 's1', filePath: first, error: '로그 파일에 쓸 수 없어 기록을 중단했습니다.' })
    expect(logger.list()).toEqual([])
    expect(closed).toEqual([first])
    expect(() => logger.write('s1', 'b\r\n')).not.toThrow()
  })

  describe('with a recorder the test controls', () => {
    /** A recorder that hands out lines only when the test says so. */
    function manualRecorder({ writeThrows = false, finish } = {}) {
      const control = { onLine: null, disposed: 0 }
      const createRecorder = ({ onLine }) => {
        control.onLine = onLine
        return {
          write: () => { if (writeThrows) throw new Error('write data discarded') },
          resize: () => {},
          finish: finish ? () => finish(control) : async () => {},
          dispose: () => { control.disposed++ }
        }
      }
      return { control, createRecorder }
    }

    it('never writes to the file again after a failure, and reports it once', async () => {
      const { control, createRecorder } = manualRecorder()
      const { logger, files, stopped, state, closed } = setup({ createRecorder })
      logger.start('s1', '웹서버')
      state.failWrite = true
      control.onLine('a')
      await vi.waitFor(() => expect(stopped).toHaveLength(1))
      state.failWrite = false
      const before = files.get(first)
      control.onLine('late line from the recorder')
      await new Promise(resolve => setTimeout(resolve, 30))
      expect(files.get(first)).toBe(before)
      expect(stopped).toHaveLength(1)
      expect(closed).toEqual([first])
      expect(control.disposed).toBeGreaterThan(0)
    })

    it('ends the log with a message when the recorder cannot take more output', () => {
      const { createRecorder } = manualRecorder({ writeThrows: true })
      const { logger, stopped, closed } = setup({ createRecorder })
      logger.start('s1', '웹서버')
      expect(() => logger.write('s1', 'x')).not.toThrow()
      expect(stopped).toEqual([{ sessionId: 's1', filePath: first, error: '출력이 너무 많아 기록을 중단했습니다.' }])
      expect(closed).toEqual([first])
      expect(logger.list()).toEqual([])
    })

    it('reports a failure from stop() when a write fails while it waits for the recorder', async () => {
      // The recorder still has a line in flight; writing it fails before finish() resolves
      const finish = (control) => new Promise((resolve) => {
        control.onLine('in flight')
        setTimeout(resolve, 40)
      })
      const { createRecorder } = manualRecorder({ finish })
      const { logger, stopped, state, closed } = setup({ createRecorder })
      logger.start('s1', '웹서버')
      state.failWrite = true
      expect(await logger.stop('s1')).toEqual({ success: false, error: '로그 파일에 쓸 수 없어 기록을 중단했습니다.', filePath: first })
      expect(stopped).toEqual([])
      expect(closed).toEqual([first])
    })

    it('closes the file when the recorder cannot be created', () => {
      const { logger, closed } = setup({ createRecorder: () => { throw new Error('no terminal') } })
      expect(logger.start('s1', '웹서버')).toEqual({ success: false, error: '로그 파일을 만들 수 없습니다.' })
      expect(closed).toEqual([first])
      expect(logger.list()).toEqual([])
    })
  })

  it('writes in batches rather than line by line', async () => {
    const { logger, files } = setup({ flushMs: 20 })
    logger.start('s1', '웹서버')
    const afterHeader = files.get(first)
    logger.write('s1', 'a\r\nb\r\n')
    await new Promise(resolve => setTimeout(resolve, 5))
    expect(files.get(first)).toBe(afterHeader)
    await vi.waitFor(() => expect(files.get(first)).toContain('a\nb\n'))
  })

  it('uses the size reported before the log started', async () => {
    const { logger, files } = setup()
    logger.resize('s1', 20, 5)
    logger.start('s1', '웹서버')
    logger.write('s1', `$ ${'a'.repeat(18)} \rbbbb\r\n`)
    await logger.stop('s1')
    expect(files.get(first)).toContain(`$ ${'a'.repeat(18)}bbbb\n`)
  })

  it('adds a note in order with the output', async () => {
    const { logger, files } = setup()
    logger.start('s1', '웹서버')
    logger.write('s1', 'before\r\n')
    logger.note('s1', '재연결됨')
    logger.write('s1', 'after\r\n')
    await logger.stop('s1')
    // The note starts on a line of its own, whatever the cursor position was; here that leaves an empty line
    expect(files.get(first)).toContain('before\n\n[재연결됨]\nafter\n')
  })

  it('closeAllNow() writes what is pending and the footer at once', () => {
    const { logger, files, closed } = setup({ flushMs: 10_000 })
    logger.start('s1', '웹서버')
    logger.closeAllNow()
    expect(files.get(first).endsWith('=== 종료 2026-10-02 09:05:07 ===\n')).toBe(true)
    expect(closed).toEqual([first])
    expect(logger.list()).toEqual([])
  })

  it('stopping a session that is not logged is not an error', async () => {
    const { logger } = setup()
    expect(await logger.stop('nope')).toEqual({ success: false, error: '기록 중인 로그가 없습니다.' })
  })
})
