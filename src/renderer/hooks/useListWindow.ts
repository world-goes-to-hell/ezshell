import { useCallback, useEffect, useLayoutEffect, useState, type RefObject } from 'react'
import { scrollTopToShow, windowRange, type WindowRange } from '../lib/listWindow'

const FALLBACK_ROW_HEIGHT = 26
const OVERSCAN_ROWS = 12
const INITIAL_ROWS = 60

interface ListWindow extends WindowRange {
  rowHeight: number
  /** Scrolls so the row is in view (it need not be drawn yet) */
  scrollToIndex: (index: number) => void
}

/**
 * Draws only the rows of a long list that are in view. The caller gives the rows' container the
 * height of all rows (`count * rowHeight`) and draws rows `start` to `end` after a spacer of
 * `start * rowHeight`. Rows carry `data-list-row` so their height can be measured.
 *
 * @param scrollRef the element that scrolls
 * @param rowsRef the container of the rows inside it
 * @param topInset what covers the top of the view (a sticky header)
 */
export function useListWindow(
  scrollRef: RefObject<HTMLElement | null>,
  rowsRef: RefObject<HTMLElement | null>,
  count: number,
  topInset = 0
): ListWindow {
  const [state, setState] = useState({ start: 0, end: Math.min(count, INITIAL_ROWS), rowHeight: FALLBACK_ROW_HEIGHT })

  const geometry = useCallback(() => {
    const scroller = scrollRef.current
    const rows = rowsRef.current
    if (!scroller || !rows) return null
    const sample = rows.querySelector<HTMLElement>('[data-list-row]')
    return {
      scroller,
      rowHeight: sample?.offsetHeight || FALLBACK_ROW_HEIGHT,
      rowsTop: rows.getBoundingClientRect().top - scroller.getBoundingClientRect().top + scroller.scrollTop,
      viewHeight: scroller.clientHeight
    }
  }, [scrollRef, rowsRef])

  const measure = useCallback(() => {
    const g = geometry()
    if (!g) return
    const next = windowRange({ scrollTop: g.scroller.scrollTop, viewHeight: g.viewHeight, rowsTop: g.rowsTop, rowHeight: g.rowHeight, count, overscan: OVERSCAN_ROWS })
    setState(prev => (prev.start === next.start && prev.end === next.end && prev.rowHeight === g.rowHeight ? prev : { ...next, rowHeight: g.rowHeight }))
  }, [geometry, count])

  // After every render: the list may have changed length, or rows above it may have appeared
  useLayoutEffect(measure)

  useEffect(() => {
    const scroller = scrollRef.current
    if (!scroller) return
    let frame = 0
    const onScroll = () => {
      if (frame) return
      frame = requestAnimationFrame(() => {
        frame = 0
        measure()
      })
    }
    scroller.addEventListener('scroll', onScroll, { passive: true })
    const observer = new ResizeObserver(measure)
    observer.observe(scroller)
    return () => {
      scroller.removeEventListener('scroll', onScroll)
      observer.disconnect()
      if (frame) cancelAnimationFrame(frame)
    }
  }, [scrollRef, measure])

  const scrollToIndex = useCallback((index: number) => {
    const g = geometry()
    if (!g || index < 0 || index >= count) return
    const top = scrollTopToShow(index, { scrollTop: g.scroller.scrollTop, viewHeight: g.viewHeight, rowsTop: g.rowsTop, rowHeight: g.rowHeight, topInset })
    if (top === null) return
    g.scroller.scrollTop = top
    measure()
  }, [geometry, measure, count, topInset])

  // A shorter list than the drawn range (new folder): never ask for rows that are not there
  const end = Math.min(state.end, count)
  return { start: Math.min(state.start, end), end, rowHeight: state.rowHeight, scrollToIndex }
}
