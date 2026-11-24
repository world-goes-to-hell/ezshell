import { describe, expect, it } from 'vitest'
import { stripOverflow, wheelScroll } from './tabStrip'

describe('stripOverflow', () => {
  it('tells which ends hide tabs', () => {
    expect(stripOverflow(0, 500, 500)).toEqual({ start: false, end: false })
    expect(stripOverflow(0, 500, 900)).toEqual({ start: false, end: true })
    expect(stripOverflow(200, 500, 900)).toEqual({ start: true, end: true })
    expect(stripOverflow(400, 500, 900)).toEqual({ start: true, end: false })
  })

  it('ignores a pixel of rounding at either end', () => {
    expect(stripOverflow(0.5, 500, 900.5)).toEqual({ start: false, end: true })
    expect(stripOverflow(399.6, 500, 900)).toEqual({ start: true, end: false })
  })
})

describe('wheelScroll', () => {
  it('turns a vertical wheel into sideways scrolling', () => {
    expect(wheelScroll({ deltaX: 0, deltaY: 100, ctrlKey: false }, false)).toBe(100)
    expect(wheelScroll({ deltaX: 0, deltaY: -60, ctrlKey: false }, false)).toBe(-60)
  })

  it('leaves alone a sideways turn, Ctrl+wheel (zoom) and a strip that fits', () => {
    expect(wheelScroll({ deltaX: 40, deltaY: 10, ctrlKey: false }, false)).toBeNull()
    expect(wheelScroll({ deltaX: 0, deltaY: 100, ctrlKey: true }, false)).toBeNull()
    expect(wheelScroll({ deltaX: 0, deltaY: 100, ctrlKey: false }, true)).toBeNull()
    expect(wheelScroll({ deltaX: 0, deltaY: 0, ctrlKey: false }, false)).toBeNull()
  })
})
