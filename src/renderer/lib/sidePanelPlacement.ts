/**
 * Where a submenu's side panel goes so it stays inside the window: right of its menu row, else left,
 * else (narrow window) pushed inside; moved up when it would run off the bottom.
 */

interface Rect {
  left: number
  top: number
  right: number
  bottom: number
}

interface Size {
  width: number
  height: number
}

export interface SidePanelPlacement {
  /** Offsets from the anchor row's top-left corner (the panel is positioned inside it) */
  left: number
  top: number
  /** The panel scrolls past this height */
  maxHeight: number
}

const GAP_PX = 8
const VIEWPORT_MARGIN_PX = 8
// Lines the panel's first row up with the menu row (menu padding + border)
const ROW_ALIGN_PX = -5

export function placeSidePanel(anchor: Rect, panel: Size, viewport: Size): SidePanelPlacement {
  const maxHeight = viewport.height - VIEWPORT_MARGIN_PX * 2
  const width = Math.min(panel.width, viewport.width - VIEWPORT_MARGIN_PX * 2)
  const height = Math.min(panel.height, maxHeight)

  const rightX = anchor.right + GAP_PX
  const leftX = anchor.left - GAP_PX - width
  const maxX = viewport.width - VIEWPORT_MARGIN_PX - width
  let x: number
  if (rightX <= maxX) x = rightX
  else if (leftX >= VIEWPORT_MARGIN_PX) x = leftX
  else x = Math.max(VIEWPORT_MARGIN_PX, Math.min(rightX, maxX))

  const maxY = viewport.height - VIEWPORT_MARGIN_PX - height
  const y = Math.max(VIEWPORT_MARGIN_PX, Math.min(anchor.top + ROW_ALIGN_PX, maxY))

  return { left: x - anchor.left, top: y - anchor.top, maxHeight }
}

/** One axis: at the pointer, else flipped before it, else pushed inside the window */
function placeOnAxis(pointer: number, size: number, viewportSize: number): number {
  const max = viewportSize - VIEWPORT_MARGIN_PX - size
  if (pointer <= max) return pointer
  if (pointer - size >= VIEWPORT_MARGIN_PX) return pointer - size
  return Math.max(VIEWPORT_MARGIN_PX, Math.min(pointer, max))
}

/** Top-left of a right-click menu: at the pointer, opening up / left where it would leave the window (like OS menus). */
export function placeContextMenu(pointer: { x: number; y: number }, menu: Size, viewport: Size): { x: number; y: number } {
  return {
    x: placeOnAxis(pointer.x, menu.width, viewport.width),
    y: placeOnAxis(pointer.y, menu.height, viewport.height)
  }
}
