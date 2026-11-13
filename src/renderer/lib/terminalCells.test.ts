import { describe, it, expect } from 'vitest'
import { hasWideCharacters, isWideCodePoint, splitWideRuns } from './terminalCells'

describe('isWideCodePoint', () => {
  it('counts Korean, Chinese, Japanese, fullwidth forms and emoji as two cells', () => {
    for (const char of ['한', '국', '中', 'あ', 'カ', 'Ａ', '１', '　', '😀']) expect(isWideCodePoint(char.codePointAt(0)!), char).toBe(true)
  })

  it('counts Latin text, digits, punctuation and box drawing as one cell', () => {
    for (const char of ['a', 'Z', '0', ' ', '|', '-', '+', 'é', '─', '│', '→', '\t', '\n']) expect(isWideCodePoint(char.codePointAt(0)!), JSON.stringify(char)).toBe(false)
  })
})

describe('splitWideRuns', () => {
  it('splits a table row into narrow and wide runs with the cells the wide ones take', () => {
    expect(splitWideRuns(' 1 | 한국오가목노벌레 | Quin')).toEqual([
      { text: ' 1 | ', isWide: false, cells: 0 },
      { text: '한국오가목노벌레', isWide: true, cells: 16 },
      { text: ' | Quin', isWide: false, cells: 0 }
    ])
  })

  it('gives the text back when its runs are joined, line breaks included', () => {
    const text = 'id | 이름\n---+------\n 1 | 해양생물 분류 및 다양성 연구 2025\n'
    expect(splitWideRuns(text).map((run) => run.text).join('')).toBe(text)
    // A space between words ends a wide run: each word is sized on its own
    expect(splitWideRuns('해양생물 분류').map((run) => run.cells)).toEqual([8, 0, 4])
  })

  it('handles text without wide characters, empty text and characters outside the basic plane', () => {
    expect(splitWideRuns('docker ps')).toEqual([{ text: 'docker ps', isWide: false, cells: 0 }])
    expect(splitWideRuns('')).toEqual([])
    expect(splitWideRuns('a😀b')).toEqual([{ text: 'a', isWide: false, cells: 0 }, { text: '😀', isWide: true, cells: 2 }, { text: 'b', isWide: false, cells: 0 }])
  })
})

describe('hasWideCharacters', () => {
  it('tells output that needs sizing from output that does not', () => {
    expect(hasWideCharacters('CONTAINER ID   IMAGE')).toBe(false)
    expect(hasWideCharacters('이름')).toBe(true)
  })
})
