import { describe, it, expect } from 'vitest'
import { windowRange, scrollTopToShow } from './listWindow'

const base = { viewHeight: 260, rowsTop: 60, rowHeight: 26, count: 20000, overscan: 5 }

describe('windowRange', () => {
  it('draws the rows in view and a few around them', () => {
    expect(windowRange({ ...base, scrollTop: 0 })).toEqual({ start: 0, end: 13 })
    // Scrolled 100 rows down: rows 98..110 are in view
    expect(windowRange({ ...base, scrollTop: 60 + 26 * 100 })).toEqual({ start: 95, end: 115 })
  })

  it('stops at the end of the list', () => {
    expect(windowRange({ ...base, count: 8, scrollTop: 0 })).toEqual({ start: 0, end: 8 })
    expect(windowRange({ ...base, scrollTop: 60 + 26 * 19995 })).toEqual({ start: 19990, end: 20000 })
    expect(windowRange({ ...base, count: 50, scrollTop: 999999 })).toEqual({ start: 50, end: 50 })
  })

  it('draws nothing for an empty list or before the row height is known', () => {
    expect(windowRange({ ...base, count: 0, scrollTop: 0 })).toEqual({ start: 0, end: 0 })
    expect(windowRange({ ...base, rowHeight: 0, scrollTop: 0 })).toEqual({ start: 0, end: 0 })
  })
})

describe('scrollTopToShow', () => {
  const view = { viewHeight: 260, rowsTop: 60, rowHeight: 26, topInset: 32 }

  it('leaves the view alone when the row is in it', () => {
    expect(scrollTopToShow(3, { ...view, scrollTop: 0 })).toBeNull()
  })

  it('scrolls down just enough to show a row below', () => {
    // Row 20 ends at 60 + 21 * 26 = 606
    expect(scrollTopToShow(20, { ...view, scrollTop: 0 })).toBe(606 - 260)
  })

  it('scrolls up so the row clears the sticky header', () => {
    // Row 50 starts at 1360
    expect(scrollTopToShow(50, { ...view, scrollTop: 5000 })).toBe(1360 - 32)
    expect(scrollTopToShow(0, { ...view, scrollTop: 40 })).toBe(28)
  })
})
