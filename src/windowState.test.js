import { describe, it, expect } from 'vitest'
import { usableState } from './windowState.js'

const SCREEN = [{ x: 0, y: 0, width: 1920, height: 1040 }]
const TWO = [...SCREEN, { x: 1920, y: 0, width: 2560, height: 1400 }]

describe('usableState', () => {
  it('uses a place that is on the screen', () => {
    expect(usableState({ x: 100.4, y: 50, width: 1200, height: 800, isMaximized: true }, SCREEN))
      .toEqual({ x: 100, y: 50, width: 1200, height: 800, isMaximized: true })
  })

  it('uses a place on the second monitor while it is connected, and not after', () => {
    const saved = { x: 2200, y: 100, width: 1400, height: 900 }
    expect(usableState(saved, TWO)).toMatchObject({ x: 2200, isMaximized: false })
    expect(usableState(saved, SCREEN)).toBeNull()
  })

  it('refuses a window whose title bar is off the screen', () => {
    expect(usableState({ x: 100, y: -400, width: 1200, height: 800 }, SCREEN)).toBeNull()
    expect(usableState({ x: 100, y: 1000, width: 1200, height: 800 }, SCREEN)).toBeNull()
    expect(usableState({ x: -1100, y: 50, width: 1200, height: 800 }, SCREEN)).toBeNull()
  })

  it('refuses broken or too small values', () => {
    expect(usableState(null, SCREEN)).toBeNull()
    expect(usableState({ x: 'a', y: 0, width: 1200, height: 800 }, SCREEN)).toBeNull()
    expect(usableState({ x: 0, y: 0, width: 300, height: 800 }, SCREEN)).toBeNull()
    expect(usableState({ x: 0, y: 0, width: 1200, height: NaN }, SCREEN)).toBeNull()
  })
})
