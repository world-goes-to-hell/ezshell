import { describe, it, expect } from 'vitest'
import { clampWindowOpacity, effectiveSurface, parseSurface, MIN_WINDOW_OPACITY } from './appearance'

describe('parseSurface', () => {
  it('is flat unless glass was stored', () => {
    expect(parseSurface('glass')).toBe('glass')
    for (const value of ['flat', '', undefined, null, 1, 'Glass']) expect(parseSurface(value)).toBe('flat')
  })
})

describe('effectiveSurface', () => {
  it('follows the choice on ordinary themes', () => {
    expect(effectiveSurface('macos-light', 'glass')).toBe('glass')
    expect(effectiveSurface('dracula', 'flat')).toBe('flat')
  })

  it('keeps the high-contrast theme solid', () => {
    expect(effectiveSurface('high-contrast', 'glass')).toBe('flat')
  })
})

describe('clampWindowOpacity', () => {
  it('keeps a value in range, to two decimals', () => {
    expect(clampWindowOpacity(0.8)).toBe(0.8)
    expect(clampWindowOpacity(0.876)).toBe(0.88)
  })

  it('never makes the window fainter than the minimum', () => {
    expect(clampWindowOpacity(0)).toBe(MIN_WINDOW_OPACITY)
    expect(clampWindowOpacity(-3)).toBe(MIN_WINDOW_OPACITY)
    expect(clampWindowOpacity(7)).toBe(1)
  })

  it('falls back to opaque for anything that is not a number', () => {
    for (const value of [undefined, null, '0.7', Number.NaN, Number.POSITIVE_INFINITY, {}]) {
      expect(clampWindowOpacity(value)).toBe(1)
    }
  })
})
