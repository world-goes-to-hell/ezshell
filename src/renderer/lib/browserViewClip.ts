// The browser tab's page is a native view drawn above the app, so app panels that slide over the
// tab (the folded sidebar opened by hovering, the MCP activity panel) would sit under it (reported
// 2026-11-20). The page gives way: it is narrowed to the part no side panel covers.

export interface Box {
  x: number
  y: number
  width: number
  height: number
}

/** Shown no narrower than this; a panel leaving less hides the page instead */
export const MIN_VISIBLE_WIDTH = 80

/**
 * The part of `view` that `panels` leave uncovered, or null when nothing useful is left. A panel on
 * the left half cuts the view from the left, one on the right half from the right. Panels that do
 * not overlap are ignored.
 */
export function uncoveredBox(view: Box, panels: readonly Box[]): Box | null {
  let left = view.x
  let right = view.x + view.width
  const middle = view.x + view.width / 2
  for (const panel of panels) {
    const panelRight = panel.x + panel.width
    const overlaps = panel.width > 0 && panel.height > 0 && panel.x < right && panelRight > left
      && panel.y < view.y + view.height && panel.y + panel.height > view.y
    if (!overlaps) continue
    if (panel.x + panel.width / 2 <= middle) left = Math.max(left, panelRight)
    else right = Math.min(right, panel.x)
  }
  if (right - left < MIN_VISIBLE_WIDTH) return null
  return { x: left, y: view.y, width: right - left, height: view.height }
}
