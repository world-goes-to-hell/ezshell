import { describe, expect, it } from 'vitest'
import { createRightClickFilter } from './rightClickReports'

const sgr = (code: number, final: 'M' | 'm') => `\x1b[<${code};10;5${final}`
const x10 = (code: number) => '\x1b[M' + String.fromCharCode(32 + code, 32 + 10, 32 + 5)

describe('createRightClickFilter', () => {
  it('drops SGR right button press, release and drag (Codex pastes the clipboard on a right click)', () => {
    const filter = createRightClickFilter()
    expect(filter(sgr(2, 'M'))).toBe('')
    expect(filter(sgr(2 + 32, 'M'))).toBe('')
    expect(filter(sgr(2, 'm'))).toBe('')
    // with Shift (4) / Ctrl (16)
    expect(filter(sgr(2 + 4, 'M'))).toBe('')
    expect(filter(sgr(2 + 16, 'm'))).toBe('')
  })

  it('keeps the left and middle buttons, the wheel and plain movement', () => {
    const filter = createRightClickFilter()
    for (const report of [sgr(0, 'M'), sgr(0, 'm'), sgr(1, 'M'), sgr(64, 'M'), sgr(65, 'M'), sgr(35, 'M'), sgr(32, 'M')]) {
      expect(filter(report)).toBe(report)
    }
  })

  it('drops a right press of the default encoding and the release that follows it', () => {
    const filter = createRightClickFilter()
    expect(filter(x10(2))).toBe('')
    expect(filter(x10(3))).toBe('')
    // A release after a left press belongs to the left button
    expect(filter(x10(0))).toBe(x10(0))
    expect(filter(x10(3))).toBe(x10(3))
  })

  it('leaves typed input untouched, including around a report', () => {
    const filter = createRightClickFilter()
    expect(filter('ls -la\r')).toBe('ls -la\r')
    expect(filter('a' + sgr(2, 'M') + 'b')).toBe('ab')
    expect(filter('\x1b[A')).toBe('\x1b[A')
  })
})
