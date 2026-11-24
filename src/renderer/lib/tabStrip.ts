// A tab strip that scrolls sideways when its tabs do not fit (design review D5: before, tabs past the
// width and the + button were cut off and could not be reached)

/** Which ends have tabs scrolled out of sight, for the fades at the strip's edges */
export function stripOverflow(scrollLeft: number, clientWidth: number, scrollWidth: number): { start: boolean; end: boolean } {
  return { start: scrollLeft > 1, end: scrollLeft + clientWidth < scrollWidth - 1 }
}

/**
 * How far a wheel turn moves the strip sideways, or null to leave the wheel alone: a mouse wheel turns
 * up and down only, so its vertical turn scrolls the strip. A sideways turn (touchpad) already scrolls,
 * Ctrl+wheel is the app's zoom, and a strip that fits does not move.
 */
export function wheelScroll(event: { deltaX: number; deltaY: number; ctrlKey: boolean }, fits: boolean): number | null {
  if (fits || event.ctrlKey) return null
  if (Math.abs(event.deltaY) <= Math.abs(event.deltaX)) return null
  return event.deltaY
}
