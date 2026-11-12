// Which rows of a long list to draw: the ones in view and a few around them. A folder with twenty
// thousand files drawn whole froze the window for seconds; every row has the same height, so the
// rows in view follow from the scroll position alone.

export interface WindowInput {
  scrollTop: number
  /** Height of the scrolling element */
  viewHeight: number
  /** Where the first row starts inside the scrolling content (after headers and other rows) */
  rowsTop: number
  rowHeight: number
  count: number
  /** Rows drawn beyond each edge so a quick scroll does not show a blank strip */
  overscan: number
}

export interface WindowRange {
  /** First row drawn */
  start: number
  /** One past the last row drawn */
  end: number
}

export function windowRange({ scrollTop, viewHeight, rowsTop, rowHeight, count, overscan }: WindowInput): WindowRange {
  if (count <= 0 || rowHeight <= 0) return { start: 0, end: 0 }
  const first = Math.floor((scrollTop - rowsTop) / rowHeight) - overscan
  const last = Math.ceil((scrollTop + viewHeight - rowsTop) / rowHeight) + overscan
  const start = Math.min(Math.max(first, 0), count)
  return { start, end: Math.min(Math.max(last, start), count) }
}

/**
 * The scroll position that brings row `index` into view, or null when it already is.
 * `topInset` is what covers the top of the view (a sticky header).
 */
export function scrollTopToShow(index: number, { scrollTop, viewHeight, rowsTop, rowHeight, topInset }: {
  scrollTop: number
  viewHeight: number
  rowsTop: number
  rowHeight: number
  topInset: number
}): number | null {
  const top = rowsTop + index * rowHeight
  if (top < scrollTop + topInset) return Math.max(0, top - topInset)
  if (top + rowHeight > scrollTop + viewHeight) return top + rowHeight - viewHeight
  return null
}
