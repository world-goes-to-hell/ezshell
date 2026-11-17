/** Where the themed tooltip goes: under its element, centered; above when there is no room below. */

export interface Box {
  left: number
  top: number
  width: number
  height: number
}

export interface Size {
  width: number
  height: number
}

/** Distance between the element and the tooltip */
export const TOOLTIP_GAP = 8
/** The tooltip keeps this far from the window edges */
export const TOOLTIP_MARGIN = 6

const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value))

export function placeTooltip(anchor: Box, tip: Size, viewport: Size): { left: number; top: number; placement: 'below' | 'above' } {
  const below = anchor.top + anchor.height + TOOLTIP_GAP
  const above = anchor.top - TOOLTIP_GAP - tip.height
  const fitsBelow = below + tip.height + TOOLTIP_MARGIN <= viewport.height
  // Above only when it fits there; otherwise below, pushed up to stay inside the window
  const placement = fitsBelow || above < TOOLTIP_MARGIN ? 'below' : 'above'
  const top = placement === 'below'
    ? clamp(below, TOOLTIP_MARGIN, Math.max(TOOLTIP_MARGIN, viewport.height - tip.height - TOOLTIP_MARGIN))
    : above
  const centered = anchor.left + anchor.width / 2 - tip.width / 2
  const left = clamp(centered, TOOLTIP_MARGIN, Math.max(TOOLTIP_MARGIN, viewport.width - tip.width - TOOLTIP_MARGIN))
  return { left: Math.round(left), top: Math.round(top), placement }
}
