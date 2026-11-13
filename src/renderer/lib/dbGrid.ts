// Small calculations of the DB result grid and the tree beside it.

/** The column order after the column at place `from` is dropped on place `to` */
export function moveColumn(order: number[], from: number, to: number): number[] {
  if (from === to || from < 0 || to < 0 || from >= order.length || to >= order.length) return order
  const next = order.slice()
  const [moved] = next.splice(from, 1)
  next.splice(to, 0, moved)
  return next
}

export const TREE_MIN_WIDTH = 180
export const TREE_MAX_WIDTH = 640
export const TREE_DEFAULT_WIDTH = 248

/** A width for the DB tree within its limits, also leaving room for the query side */
export function clampTreeWidth(width: number, available = Infinity): number {
  const max = Math.max(TREE_MIN_WIDTH, Math.min(TREE_MAX_WIDTH, available - 320))
  if (!Number.isFinite(width)) return TREE_DEFAULT_WIDTH
  return Math.round(Math.min(max, Math.max(TREE_MIN_WIDTH, width)))
}

/** A cell of the grid: its row and its place on screen (columns can be moved, so not its column index) */
export interface GridPosition {
  row: number
  place: number
}

/** A block of cells, both ends included */
export interface GridRange {
  rowFrom: number
  rowTo: number
  placeFrom: number
  placeTo: number
}

/** The block between two cells, whichever way it was dragged */
export function rangeOf(a: GridPosition, b: GridPosition): GridRange {
  return {
    rowFrom: Math.min(a.row, b.row),
    rowTo: Math.max(a.row, b.row),
    placeFrom: Math.min(a.place, b.place),
    placeTo: Math.max(a.place, b.place)
  }
}

/**
 * A block of cells as tab-separated text, in the order shown (`order[place]` is the column index).
 * NULL is left empty and tabs / line breaks inside a value become a space, so each cell lands in
 * one spreadsheet cell.
 */
export function rangeAsTsv(rows: ReadonlyArray<ReadonlyArray<string | number | boolean | null>>, order: number[], range: GridRange): string {
  const lines: string[] = []
  for (let row = range.rowFrom; row <= range.rowTo; row++) {
    const cells: string[] = []
    for (let place = range.placeFrom; place <= range.placeTo; place++) {
      const cell = rows[row]?.[order[place]]
      cells.push(cell === null || cell === undefined ? '' : String(cell).replace(/[\t\r\n]+/g, ' '))
    }
    lines.push(cells.join('\t'))
  }
  return lines.join('\n')
}
