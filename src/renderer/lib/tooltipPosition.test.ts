import { describe, it, expect } from 'vitest'
import { placeTooltip, TOOLTIP_GAP, TOOLTIP_MARGIN } from './tooltipPosition'

const viewport = { width: 1000, height: 700 }
const tip = { width: 120, height: 28 }

describe('placeTooltip', () => {
  it('goes under the element, centered', () => {
    const at = placeTooltip({ left: 400, top: 100, width: 40, height: 30 }, tip, viewport)
    expect(at).toEqual({ left: 360, top: 130 + TOOLTIP_GAP, placement: 'below' })
  })

  it('goes above an element at the bottom of the window (status bar)', () => {
    const at = placeTooltip({ left: 400, top: 670, width: 40, height: 24 }, tip, viewport)
    expect(at.placement).toBe('above')
    expect(at.top).toBe(670 - TOOLTIP_GAP - tip.height)
  })

  it('stays inside the left and right edges', () => {
    expect(placeTooltip({ left: 2, top: 100, width: 20, height: 20 }, tip, viewport).left).toBe(TOOLTIP_MARGIN)
    expect(placeTooltip({ left: 980, top: 100, width: 20, height: 20 }, tip, viewport).left).toBe(1000 - tip.width - TOOLTIP_MARGIN)
  })

  it('stays inside the window when neither side has room', () => {
    const tall = { width: 120, height: 400 }
    const at = placeTooltip({ left: 400, top: 300, width: 40, height: 100 }, tall, viewport)
    expect(at.placement).toBe('below')
    expect(at.top + tall.height).toBeLessThanOrEqual(viewport.height - TOOLTIP_MARGIN)
  })
})
