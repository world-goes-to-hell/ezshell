import { describe, it, expect } from 'vitest'
import { bufferText, outputFileName, findQueryFromSelection } from './terminalText'

const buffer = (rows: Array<[string, boolean?]>) => ({
  length: rows.length,
  getLine: (i: number) => ({ isWrapped: rows[i][1] === true, translateToString: () => rows[i][0] })
})

describe('bufferText', () => {
  it('joins wrapped lines and drops the empty end of the screen', () => {
    expect(bufferText(buffer([['$ echo a very long', false], [' command', true], ['', false], ['done', false], ['', false], ['', false]])))
      .toBe('$ echo a very long command\n\ndone')
  })

  it('is empty for an empty terminal', () => {
    expect(bufferText(buffer([['', false], ['', false]]))).toBe('')
  })
})

describe('outputFileName', () => {
  it('uses the tab name without path characters and the time', () => {
    expect(outputFileName('[운영] web/01: a?', new Date(2026, 10, 12, 9, 5, 7))).toBe('[운영] web_01_ a__20261112-090507.txt')
  })

  it('falls back to a plain name', () => {
    expect(outputFileName('  ', new Date(2026, 0, 1, 0, 0, 0))).toBe('terminal_20260101-000000.txt')
  })
})

describe('findQueryFromSelection', () => {
  it('takes a short one-line selection', () => {
    expect(findQueryFromSelection('  nginx.conf ', 200)).toBe('nginx.conf')
  })

  it('ignores several lines, control characters and long text', () => {
    expect(findQueryFromSelection('a\nb', 200)).toBe('')
    expect(findQueryFromSelection('a\tb', 200)).toBe('')
    expect(findQueryFromSelection('x'.repeat(201), 200)).toBe('')
    expect(findQueryFromSelection('', 200)).toBe('')
  })
})
