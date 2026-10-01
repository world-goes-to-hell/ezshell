import { describe, it, expect } from 'vitest'
import { placeSidePanel, placeContextMenu } from './sidePanelPlacement'

const viewport = { width: 1200, height: 800 }
// A context-menu row: 200px wide at (100, 300)
const anchor = { left: 100, top: 300, right: 300, bottom: 332 }
const panel = { width: 260, height: 300 }

describe('placeSidePanel', () => {
  it('opens to the right of the anchor, first row level with it (offsets relative to the anchor)', () => {
    expect(placeSidePanel(anchor, panel, viewport)).toEqual({ left: 208, top: -5, maxHeight: 784 })
  })

  it('opens to the left when the right side has no room', () => {
    const nearRight = { left: 900, top: 300, right: 1100, bottom: 332 }

    expect(placeSidePanel(nearRight, panel, viewport).left).toBe(-268)
  })

  it('stays inside the window when neither side has room (narrow window)', () => {
    const narrow = { width: 420, height: 800 }
    const wide = { left: 20, top: 300, right: 380, bottom: 332 }

    const placed = placeSidePanel(wide, panel, narrow)
    const screenLeft = wide.left + placed.left

    expect(screenLeft).toBeGreaterThanOrEqual(8)
    expect(screenLeft + panel.width).toBeLessThanOrEqual(narrow.width - 8)
  })

  it('moves up so the bottom stays inside the window', () => {
    const low = { left: 100, top: 700, right: 300, bottom: 732 }

    const placed = placeSidePanel(low, panel, viewport)

    expect(low.top + placed.top + panel.height).toBe(viewport.height - 8)
  })

  it('caps the height to the window and starts at the top margin when the panel is taller than the window', () => {
    const tall = { width: 260, height: 2000 }

    const placed = placeSidePanel(anchor, tall, viewport)

    expect(placed.maxHeight).toBe(784)
    expect(anchor.top + placed.top).toBe(8)
  })
})

describe('placeContextMenu', () => {
  const menu = { width: 180, height: 220 }

  it('opens at the pointer when it fits', () => {
    expect(placeContextMenu({ x: 100, y: 200 }, menu, viewport)).toEqual({ x: 100, y: 200 })
  })

  it('opens upward from the pointer near the bottom, like an OS menu', () => {
    expect(placeContextMenu({ x: 100, y: 700 }, menu, viewport)).toEqual({ x: 100, y: 480 })
  })

  it('opens to the left of the pointer near the right edge', () => {
    expect(placeContextMenu({ x: 1100, y: 200 }, menu, viewport).x).toBe(920)
  })

  it('stays inside a window too small for either direction', () => {
    const tiny = { width: 300, height: 260 }
    const placed = placeContextMenu({ x: 150, y: 130 }, menu, tiny)

    expect(placed.y).toBeGreaterThanOrEqual(8)
    expect(placed.y + menu.height).toBeLessThanOrEqual(tiny.height - 8)
    expect(placed.x + menu.width).toBeLessThanOrEqual(tiny.width - 8)
    expect(placed.x).toBeGreaterThanOrEqual(8)
  })
})
