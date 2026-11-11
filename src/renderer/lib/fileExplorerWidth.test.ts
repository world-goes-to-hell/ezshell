import { describe, it, expect } from 'vitest'
import {
  clampExplorerWidth,
  parseExplorerWidth,
  FILE_EXPLORER_DEFAULT_WIDTH,
  FILE_EXPLORER_MIN_WIDTH,
  FILE_EXPLORER_MAX_WIDTH,
} from './fileExplorerWidth'

describe('clampExplorerWidth', () => {
  it('keeps widths inside the range', () => {
    expect(clampExplorerWidth(300)).toBe(300)
  })

  it('does not go below the minimum', () => {
    expect(clampExplorerWidth(20)).toBe(FILE_EXPLORER_MIN_WIDTH)
  })

  it('does not go above the absolute maximum', () => {
    expect(clampExplorerWidth(5000)).toBe(FILE_EXPLORER_MAX_WIDTH)
  })

  it('leaves at least 30% of the terminal body for the shell', () => {
    expect(clampExplorerWidth(900, 1000)).toBe(700)
  })

  it('keeps the minimum even in a very narrow terminal', () => {
    expect(clampExplorerWidth(300, 100)).toBe(FILE_EXPLORER_MIN_WIDTH)
  })

  it('falls back to the default for non-numbers', () => {
    expect(clampExplorerWidth(Number.NaN)).toBe(FILE_EXPLORER_DEFAULT_WIDTH)
  })
})

describe('parseExplorerWidth', () => {
  it('reads a stored width', () => {
    expect(parseExplorerWidth('340')).toBe(340)
  })

  it('uses the default when nothing or garbage is stored', () => {
    expect(parseExplorerWidth(null)).toBe(FILE_EXPLORER_DEFAULT_WIDTH)
    expect(parseExplorerWidth('abc')).toBe(FILE_EXPLORER_DEFAULT_WIDTH)
  })

  it('clamps an out-of-range stored width', () => {
    expect(parseExplorerWidth('9999')).toBe(FILE_EXPLORER_MAX_WIDTH)
  })
})
