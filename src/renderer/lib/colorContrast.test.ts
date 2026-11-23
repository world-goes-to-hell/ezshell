import { describe, it, expect } from 'vitest'
import { readableTextColor, visibleIndicatorColor } from './colorContrast'

const WHITE = '#ffffff'
const DARK = '#16181c'

describe('readableTextColor', () => {
  it('uses white on saturated mid-tone session colors (a filled blue tab with black text looked unstyled)', () => {
    for (const color of ['#3b82f6', '#ef4444', '#a855f7', '#ec4899', '#0071e3', '#2f6fed']) {
      expect(readableTextColor(color)).toBe(WHITE)
    }
  })

  it('uses dark text where white would fall under 3:1', () => {
    for (const color of ['#f97316', '#f59e0b', '#22c55e', '#14b8a6', '#ffffff', '#fde68a']) {
      expect(readableTextColor(color)).toBe(DARK)
    }
  })

  it('uses white on dark backgrounds and for colors it cannot read', () => {
    expect(readableTextColor('#000000')).toBe(WHITE)
    expect(readableTextColor('#123')).toBe(WHITE)
    expect(readableTextColor('rgb(1, 2, 3)')).toBe(WHITE)
  })
})

describe('visibleIndicatorColor', () => {
  it.each(['rgb(47, 104, 176)', 'hsl(214 58% 44%)', '#2f68b080', '#2398'])('keeps the user color %s', color => {
    expect(visibleIndicatorColor(color, ['#ffffff'])).toBe(color)
  })

  it('ignores surfaces whose displayed color depends on their backdrop', () => {
    expect(visibleIndicatorColor('#303030', ['#ffffff', '#00000080', '#0008', 'rgba(0, 0, 0, 0.5)'])).toBe('#303030')
    expect(visibleIndicatorColor('#303030', ['#00000080'])).toBe('#303030')
  })

  it('measures opaque short and long hex colors with an alpha channel', () => {
    expect(visibleIndicatorColor('#dddf', ['#ffffffff'])).toBe('#000000')
    expect(visibleIndicatorColor('#ddddddff', ['#ffff'])).toBe('#000000')
  })
})
