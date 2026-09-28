import { useEffect, type RefObject } from 'react'

// Browser default is ~100px per wheel notch (about 4 rows of a 26px list), which overshoots.
const DEFAULT_ROWS_PER_NOTCH = 2
const FALLBACK_ROW_HEIGHT = 26
// Mouse wheels report large discrete deltas; touchpads send many small ones.
// Only discrete notches are re-stepped so touchpad scrolling stays smooth.
const MIN_NOTCH_DELTA = 50
const DOM_DELTA_PIXEL = 0

/**
 * Scroll a list by a fixed number of rows per mouse-wheel notch.
 * `rowSelector` is used to measure the actual row height.
 */
export function useWheelRowScroll(
  ref: RefObject<HTMLElement | null>,
  rowSelector: string,
  rowsPerNotch: number = DEFAULT_ROWS_PER_NOTCH
) {
  useEffect(() => {
    const element = ref.current
    if (!element) return

    const handleWheel = (event: WheelEvent) => {
      // Leave zoom gestures, horizontal scrolling and touchpad deltas to the browser
      if (event.ctrlKey || event.deltaY === 0 || Math.abs(event.deltaX) > Math.abs(event.deltaY)) return
      const isNotch = event.deltaMode !== DOM_DELTA_PIXEL || Math.abs(event.deltaY) >= MIN_NOTCH_DELTA
      if (!isNotch) return

      const row = element.querySelector<HTMLElement>(rowSelector)
      const rowHeight = row?.offsetHeight || FALLBACK_ROW_HEIGHT
      event.preventDefault()
      element.scrollBy({ top: Math.sign(event.deltaY) * rowHeight * rowsPerNotch })
    }

    element.addEventListener('wheel', handleWheel, { passive: false })
    return () => element.removeEventListener('wheel', handleWheel)
  }, [ref, rowSelector, rowsPerNotch])
}
