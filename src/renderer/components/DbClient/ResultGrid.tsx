import { useMemo, useRef, useState, type KeyboardEvent } from 'react'
import type { DbCell, DbColumn } from '../../types/db'

const ROW_HEIGHT = 26
const OVERSCAN = 12
const MIN_COLUMN = 80
const MAX_COLUMN = 360
const CHAR_WIDTH = 7.4

interface ResultGridProps {
  columns: DbColumn[]
  rows: DbCell[][]
  onCopy: (text: string) => void
}

export function cellText(cell: DbCell): string {
  if (cell === null) return 'NULL'
  return String(cell)
}

/** Width from the header and the first rows' text, within limits */
function columnWidths(columns: DbColumn[], rows: DbCell[][]): number[] {
  return columns.map((column, index) => {
    let longest = column.name.length
    for (let r = 0; r < Math.min(rows.length, 50); r++) {
      longest = Math.max(longest, cellText(rows[r][index]).length)
    }
    return Math.max(MIN_COLUMN, Math.min(MAX_COLUMN, Math.round(longest * CHAR_WIDTH + 24)))
  })
}

/**
 * Query result table. Only the rows in view are in the page (up to 1,000 rows of many columns).
 * Click selects a cell, Ctrl+C copies it, arrow keys move.
 */
export function ResultGrid({ columns, rows, onCopy }: ResultGridProps) {
  const scrollRef = useRef<HTMLDivElement>(null)
  const [scrollTop, setScrollTop] = useState(0)
  const [viewHeight, setViewHeight] = useState(400)
  const [selected, setSelected] = useState<{ row: number; col: number } | null>(null)
  const widths = useMemo(() => columnWidths(columns, rows), [columns, rows])
  const template = `56px ${widths.map(w => `${w}px`).join(' ')}`
  const totalWidth = 56 + widths.reduce((sum, w) => sum + w, 0)

  const first = Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - OVERSCAN)
  const last = Math.min(rows.length, Math.ceil((scrollTop + viewHeight) / ROW_HEIGHT) + OVERSCAN)

  const onScroll = (): void => {
    const el = scrollRef.current
    if (!el) return
    setScrollTop(el.scrollTop)
    setViewHeight(el.clientHeight)
  }

  const reveal = (row: number): void => {
    const el = scrollRef.current
    if (!el) return
    const top = row * ROW_HEIGHT
    const headerHeight = ROW_HEIGHT
    if (top < el.scrollTop) el.scrollTop = top
    else if (top + ROW_HEIGHT * 2 > el.scrollTop + el.clientHeight - headerHeight) el.scrollTop = top + ROW_HEIGHT * 2 - el.clientHeight + headerHeight
  }

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (!selected) return
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'c') {
      event.preventDefault()
      onCopy(cellText(rows[selected.row][selected.col]))
      return
    }
    const moves: Record<string, [number, number]> = { ArrowUp: [-1, 0], ArrowDown: [1, 0], ArrowLeft: [0, -1], ArrowRight: [0, 1] }
    const move = moves[event.key]
    if (!move) return
    event.preventDefault()
    const row = Math.max(0, Math.min(rows.length - 1, selected.row + move[0]))
    const col = Math.max(0, Math.min(columns.length - 1, selected.col + move[1]))
    setSelected({ row, col })
    reveal(row)
  }

  return (
    <div className="db-grid" ref={scrollRef} onScroll={onScroll} tabIndex={0} onKeyDown={onKeyDown} role="grid" aria-rowcount={rows.length + 1} aria-colcount={columns.length}>
      <div className="db-grid-inner" style={{ width: totalWidth, height: (rows.length + 1) * ROW_HEIGHT }}>
        <div className="db-grid-row db-grid-head" role="row" style={{ gridTemplateColumns: template }}>
          <div className="db-grid-cell db-grid-index" role="columnheader">#</div>
          {columns.map((column, index) => (
            <div key={index} className="db-grid-cell" role="columnheader" title={`${column.name} (${column.type})`}>{column.name}</div>
          ))}
        </div>
        {rows.slice(first, last).map((row, offset) => {
          const rowIndex = first + offset
          return (
            <div key={rowIndex} className="db-grid-row" role="row" style={{ gridTemplateColumns: template, top: (rowIndex + 1) * ROW_HEIGHT }}>
              <div className="db-grid-cell db-grid-index">{rowIndex + 1}</div>
              {row.map((cell, colIndex) => {
                const isSelected = selected?.row === rowIndex && selected.col === colIndex
                const text = cellText(cell)
                return (
                  <div
                    key={colIndex}
                    role="gridcell"
                    aria-selected={isSelected}
                    className={`db-grid-cell${cell === null ? ' is-null' : ''}${typeof cell === 'number' ? ' is-number' : ''}${isSelected ? ' is-selected' : ''}`}
                    title={text.length > 40 ? text.slice(0, 2000) : undefined}
                    onMouseDown={() => setSelected({ row: rowIndex, col: colIndex })}
                  >
                    {text}
                  </div>
                )
              })}
            </div>
          )
        })}
      </div>
    </div>
  )
}

/** Tab-separated text of the whole result (header first) for pasting into a spreadsheet */
export function resultAsTsv(columns: DbColumn[], rows: DbCell[][]): string {
  const clean = (text: string): string => text.replace(/[\t\r\n]+/g, ' ')
  const lines = [columns.map(c => clean(c.name)).join('\t'), ...rows.map(r => r.map(cell => clean(cell === null ? '' : String(cell))).join('\t'))]
  return lines.join('\n')
}
