import { describe, expect, it } from 'vitest'
import { DEFAULT_SPLIT, clampSplit, readSplit, splitAt } from './markdownSplit'

describe('markdown split', () => {
  it('keeps the editor between a fifth and four fifths of the width', () => {
    expect(clampSplit(0.05)).toBe(0.2)
    expect(clampSplit(0.95)).toBe(0.8)
    expect(clampSplit(0.6)).toBe(0.6)
    expect(clampSplit(NaN)).toBe(DEFAULT_SPLIT)
  })

  it('reads a stored value, half when it is missing or odd', () => {
    expect(readSplit('0.35')).toBe(0.35)
    expect(readSplit(null)).toBe(DEFAULT_SPLIT)
    expect(readSplit('wide')).toBe(DEFAULT_SPLIT)
    expect(readSplit('3')).toBe(0.8)
  })

  it('turns the pointer position into the editor share', () => {
    expect(splitAt(300, 100, 800)).toBe(0.25)
    expect(splitAt(50, 100, 800)).toBe(0.2)
    expect(splitAt(10, 0, 0)).toBe(DEFAULT_SPLIT)
  })
})
