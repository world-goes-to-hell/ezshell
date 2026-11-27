import { describe, expect, it } from 'vitest'
import { scrollPlace } from './terminalScrollJump'

const buffer = (viewportY: number, baseY: number, type: 'normal' | 'alternate' = 'normal') => ({ viewportY, baseY, type })

describe('scrollPlace', () => {
  it('has nothing to jump to while the whole log fits on the screen', () => {
    expect(scrollPlace(buffer(0, 0))).toEqual({ scrollable: false, atTop: true, atBottom: true })
  })

  it('follows the newest lines at the bottom of a long log', () => {
    expect(scrollPlace(buffer(120, 120))).toEqual({ scrollable: true, atTop: false, atBottom: true })
  })

  it('knows the user scrolled up into the log', () => {
    expect(scrollPlace(buffer(40, 120))).toEqual({ scrollable: true, atTop: false, atBottom: false })
    expect(scrollPlace(buffer(0, 120))).toEqual({ scrollable: true, atTop: true, atBottom: false })
  })

  it('offers no jumps on a full-screen program (alternate screen has no scrollback)', () => {
    expect(scrollPlace(buffer(0, 0, 'alternate')).scrollable).toBe(false)
  })
})
