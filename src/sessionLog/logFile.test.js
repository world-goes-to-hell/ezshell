import { describe, it, expect } from 'vitest'
import path from 'path'
import logFileModule from './logFile.js'

const { safeFileName, buildLogPath, formatStamp, formatClock, headerText, footerText } = logFileModule

const at = new Date(2026, 9, 2, 9, 5, 7)

describe('safeFileName', () => {
  it('keeps an ordinary name, including Korean and brackets', () => {
    expect(safeFileName('[개발] MBRIS-PORTAL')).toBe('[개발] MBRIS-PORTAL')
  })

  it.each([
    ['..\\..\\Windows\\evil', '_.._Windows_evil'],
    ['../../etc/passwd', '_.._etc_passwd'],
    ['a:b*c?d"e<f>g|h', 'a_b_c_d_e_f_g_h'],
    ['line\nbreak\ttab', 'line_break_tab'],
    ['  trailing dots...  ', 'trailing dots'],
    ['...hidden', 'hidden']
  ])('replaces what cannot be in a file name: %j', (name, expected) => {
    expect(safeFileName(name)).toBe(expected)
  })

  it.each([[''], ['   '], ['...'], [undefined], [null], [42], ['CON'], ['nul'], ['com1'], ['LPT9']])('falls back to a neutral name for %j', (name) => {
    expect(safeFileName(name)).toBe('session')
  })

  it('caps the length', () => {
    expect(safeFileName('가'.repeat(300))).toHaveLength(80)
  })
})

describe('buildLogPath', () => {
  it('puts the file in the log folder with the start time', () => {
    expect(buildLogPath('C:\\Logs', '웹서버', at)).toBe(path.join('C:\\Logs', '웹서버_20261002-090507.log'))
  })

  it('never leaves the log folder, whatever the session is called', () => {
    for (const name of ['..\\..\\x', '../../x', 'C:\\Windows\\x', '/etc/x', '..']) {
      const file = buildLogPath('C:\\Logs', name, at)
      expect(path.dirname(file)).toBe('C:\\Logs')
    }
  })

  it('adds a counter for another file of the same second', () => {
    expect(buildLogPath('C:\\Logs', '웹서버', at, 2)).toBe(path.join('C:\\Logs', '웹서버_20261002-090507-2.log'))
  })
})

describe('time and header text', () => {
  it('formats local time with zero padding', () => {
    expect(formatStamp(at)).toBe('20261002-090507')
    expect(formatClock(at)).toBe('2026-10-02 09:05:07')
  })

  it('names the session and the times in the header and footer', () => {
    expect(headerText('웹서버', at)).toBe('=== ezShell 세션 로그: 웹서버 | 시작 2026-10-02 09:05:07 ===')
    expect(footerText(at)).toBe('=== 종료 2026-10-02 09:05:07 ===')
  })

  it('keeps line breaks in a session name out of the header', () => {
    expect(headerText('a\nb', at)).not.toContain('\n')
  })
})
