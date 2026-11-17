import { describe, it, expect } from 'vitest'
import { visibleRowLevels, isCommandLine, type RowSource } from './terminalLogRows'

/** Rows of a buffer; a string starting with "↵" is a soft-wrapped continuation of the row above */
function bufferOf(rows: string[]): RowSource {
  return {
    getLine: (y) => {
      const text = rows[y]
      if (text === undefined) return undefined
      const isWrapped = text.startsWith('↵')
      return { isWrapped, translateToString: () => (isWrapped ? text.slice(1) : text) }
    }
  }
}

const levelsOf = (rows: string[], top = 0, count = rows.length, cursorRow = rows.length) =>
  Object.fromEntries(visibleRowLevels(bufferOf(rows), top, count, cursorRow))

describe('visibleRowLevels', () => {
  it('marks error and warning lines and leaves the rest', () => {
    expect(levelsOf([
      '2026-11-17 10:00:01 INFO  started',
      '2026-11-17 10:00:02 ERROR connection refused',
      '2026-11-17 10:00:03 WARN  slow query',
      '2026-11-17 10:00:04 DEBUG tick',
      ''
    ])).toEqual({ 1: 'error', 2: 'warn' })
  })

  it('marks stack trace lines as errors', () => {
    expect(levelsOf([
      'java.lang.NullPointerException: boom',
      '    at com.example.Main.run(Main.java:12)',
      'Caused by: java.io.IOException'
    ])).toEqual({ 0: 'error', 1: 'error', 2: 'error' })
  })

  it('marks every row of a wrapped line by the whole line', () => {
    expect(levelsOf([
      '2026-11-17 10:00:02 ERROR a very long',
      '↵ message that wraps',
      'INFO sent ERROR report that also',
      '↵ wraps'
    ])).toEqual({ 0: 'error', 1: 'error' })
  })

  it('reads the start of a wrapped line that begins above the screen', () => {
    const rows = ['10:00 ERROR long', '↵ tail on screen', 'plain']
    expect(levelsOf(rows, 1, 2)).toEqual({ 1: 'error' })
  })

  it('leaves the line the cursor is on', () => {
    expect(levelsOf(['ERROR done', 'ERROR being typed'], 0, 2, 1)).toEqual({ 0: 'error' })
  })

  it('leaves command lines that mention a level', () => {
    expect(levelsOf([
      'user@web01:~$ grep ERROR app.log',
      '[root@db ~]# tail -f /var/log/ERROR.log',
      'PS C:\\Users\\me> findstr WARN app.log',
      '~/src ❯ echo ERROR'
    ])).toEqual({})
  })

  it('still marks log lines that contain prompt-like characters', () => {
    expect(levelsOf([
      '10:00 ERROR disk 95% used > threshold',
      '10:01 WARN  cost is $ 12 # of items'
    ])).toEqual({ 0: 'error', 1: 'warn' })
  })

  it('only returns rows inside the screen', () => {
    const rows = ['ERROR a', 'ERROR b', 'ERROR c', 'ERROR d']
    expect(levelsOf(rows, 1, 2)).toEqual({ 1: 'error', 2: 'error' })
  })
})

describe('isCommandLine', () => {
  it('knows common prompts', () => {
    expect(isCommandLine('ysk@host:/var/log$ ls')).toBe(true)
    expect(isCommandLine('2026-11-17 ERROR user@host said # no')).toBe(false)
  })
})
