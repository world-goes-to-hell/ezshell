import { useEffect, useMemo, useRef, useState, type DragEvent, type KeyboardEvent, type MouseEvent } from 'react'
import { RiFileCopyLine, RiLinksLine, RiSearchLine, RiTableLine } from 'react-icons/ri'
import type { DbCell, DbColumn, DbRelationTarget, DbRelations } from '../../types/db'
import { moveColumn, rangeAsTsv, rangeOf, type GridPosition } from '../../lib/dbGrid'
import { DbGridMenu, type GridMenuItem } from './DbGridMenu'

const ROW_HEIGHT = 26
const OVERSCAN = 12
const MIN_COLUMN = 80
const MAX_COLUMN = 360
const CHAR_WIDTH = 7.4
const COLUMN_DRAG_TYPE = 'application/x-ezshell-db-column'
/** Room for the foreign-key mark in a header */
const LINK_WIDTH = 22

interface ResultGridProps {
  columns: DbColumn[]
  rows: DbCell[][]
  /** Foreign keys of each column (same order as `columns`); null where there are none or not known yet */
  relations?: Array<DbRelations | null>
  onCopy: (text: string) => void
  /** Show a table a column is tied to by a foreign key */
  onOpenTable?: (target: DbRelationTarget) => void
  /** Show the rows of a related table that go with one value */
  onLookup?: (target: DbRelationTarget, value: DbCell, column: DbColumn) => void
}

export function cellText(cell: DbCell): string {
  if (cell === null) return 'NULL'
  return String(cell)
}

/** Width from the header and the first rows' text, within limits */
function columnWidths(columns: DbColumn[], rows: DbCell[][], relations: Array<DbRelations | null> | undefined): number[] {
  return columns.map((column, index) => {
    let longest = column.name.length
    for (let r = 0; r < Math.min(rows.length, 50); r++) {
      longest = Math.max(longest, cellText(rows[r][index]).length)
    }
    return Math.max(MIN_COLUMN, Math.min(MAX_COLUMN, Math.round(longest * CHAR_WIDTH + 24 + (relations?.[index] ? LINK_WIDTH : 0))))
  })
}

const hasRelations = (relation: DbRelations | null | undefined): relation is DbRelations =>
  Boolean(relation && (relation.to.length > 0 || relation.from.length > 0))

const tableLabel = (target: DbRelationTarget): string => `${target.schema}.${target.table}`

/**
 * Query result table. Only the rows in view are in the page (up to 1,000 rows of many columns).
 * - A click selects a cell and keeps its row marked; dragging (or Shift+click, Shift+arrows) selects a
 *   block of cells; Ctrl+C copies the cell or the block (tab-separated, for a spreadsheet).
 * - Headers can be dragged to another place.
 * - A column with a foreign key carries a mark that lists the tables it is tied to, and a
 *   right-click on one of its cells offers the related rows.
 * Positions are a row and a place on screen (`place`), which is not the column's index once
 * columns have been moved: `order[place]` is the index into `columns`.
 */
export function ResultGrid({ columns, rows, relations, onCopy, onOpenTable, onLookup }: ResultGridProps) {
  const scrollRef = useRef<HTMLDivElement>(null)
  const [scrollTop, setScrollTop] = useState(0)
  const [viewHeight, setViewHeight] = useState(400)
  // The selection runs from `anchor` to `focus`; one cell when they are the same
  const [anchor, setAnchor] = useState<GridPosition | null>(null)
  const [focus, setFocus] = useState<GridPosition | null>(null)
  const isSelecting = useRef(false)
  const [order, setOrder] = useState<number[]>(() => columns.map((_, index) => index))
  const [dropAt, setDropAt] = useState<number | null>(null)
  const [menu, setMenu] = useState<{ x: number; y: number; items: GridMenuItem[] } | null>(null)
  const widths = useMemo(() => columnWidths(columns, rows, relations), [columns, rows, relations])
  const template = `56px ${order.map(index => `${widths[index]}px`).join(' ')}`
  const totalWidth = 56 + widths.reduce((sum, w) => sum + w, 0)
  const range = anchor && focus ? rangeOf(anchor, focus) : null
  const isBlock = Boolean(range && (range.rowFrom !== range.rowTo || range.placeFrom !== range.placeTo))
  const lastPlace = order.length - 1

  const first = Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - OVERSCAN)
  const last = Math.min(rows.length, Math.ceil((scrollTop + viewHeight) / ROW_HEIGHT) + OVERSCAN)

  // A drag that ends outside the grid still ends
  useEffect(() => {
    const stop = (): void => { isSelecting.current = false }
    window.addEventListener('mouseup', stop)
    return () => window.removeEventListener('mouseup', stop)
  }, [])

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

  const select = (position: GridPosition, isExtending: boolean): void => {
    if (!isExtending || !anchor) setAnchor(position)
    setFocus(position)
  }

  const copySelection = (): void => {
    if (!range || !focus) return
    onCopy(isBlock ? rangeAsTsv(rows, order, range) : cellText(rows[focus.row][order[focus.place]]))
  }

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    const isCommand = event.ctrlKey || event.metaKey
    if (isCommand && event.key.toLowerCase() === 'a' && rows.length > 0 && order.length > 0) {
      event.preventDefault()
      setAnchor({ row: 0, place: 0 })
      setFocus({ row: rows.length - 1, place: lastPlace })
      return
    }
    if (!focus) return
    if (isCommand && event.key.toLowerCase() === 'c') {
      event.preventDefault()
      copySelection()
      return
    }
    const moves: Record<string, [number, number]> = { ArrowUp: [-1, 0], ArrowDown: [1, 0], ArrowLeft: [0, -1], ArrowRight: [0, 1] }
    const move = moves[event.key]
    if (!move) return
    event.preventDefault()
    const next = {
      row: Math.max(0, Math.min(rows.length - 1, focus.row + move[0])),
      place: Math.max(0, Math.min(lastPlace, focus.place + move[1]))
    }
    select(next, event.shiftKey)
    reveal(next.row)
  }

  // ---- Columns dragged to another place ----
  const onDragStart = (event: DragEvent, place: number): void => {
    event.dataTransfer.setData(COLUMN_DRAG_TYPE, String(place))
    event.dataTransfer.effectAllowed = 'move'
  }
  const onDragOver = (event: DragEvent, place: number): void => {
    if (!event.dataTransfer.types.includes(COLUMN_DRAG_TYPE)) return
    event.preventDefault()
    event.dataTransfer.dropEffect = 'move'
    if (dropAt !== place) setDropAt(place)
  }
  const onDrop = (event: DragEvent, place: number): void => {
    const from = Number(event.dataTransfer.getData(COLUMN_DRAG_TYPE))
    setDropAt(null)
    if (!event.dataTransfer.types.includes(COLUMN_DRAG_TYPE) || !Number.isInteger(from)) return
    event.preventDefault()
    setOrder(current => moveColumn(current, from, place))
    // Places now hold other columns: the block would cover cells that were not chosen
    setAnchor(null)
    setFocus(null)
  }

  // ---- Foreign keys ----
  const relationItems = (relation: DbRelations): GridMenuItem[] => {
    const items: GridMenuItem[] = []
    if (relation.to.length > 0) {
      items.push({ heading: true, label: '이 열이 참조하는 테이블' })
      for (const target of relation.to) items.push({ label: tableLabel(target), detail: target.column, icon: <RiTableLine size={14} />, onSelect: () => onOpenTable?.(target) })
    }
    if (relation.from.length > 0) {
      items.push({ heading: true, label: '이 열을 참조하는 테이블' })
      for (const target of relation.from) items.push({ label: tableLabel(target), detail: target.column, icon: <RiTableLine size={14} />, onSelect: () => onOpenTable?.(target) })
    }
    return items
  }

  const openRelations = (event: MouseEvent, index: number): void => {
    event.stopPropagation()
    const relation = relations?.[index]
    if (!hasRelations(relation)) return
    const box = event.currentTarget.getBoundingClientRect()
    setMenu({ x: box.left, y: box.bottom + 2, items: relationItems(relation) })
  }

  const openCellMenu = (event: MouseEvent, row: number, place: number): void => {
    event.preventDefault()
    const isInside = Boolean(range && isBlock && row >= range.rowFrom && row <= range.rowTo && place >= range.placeFrom && place <= range.placeTo)
    const items: GridMenuItem[] = []
    if (isInside && range) {
      const size = `${range.rowTo - range.rowFrom + 1}행 × ${range.placeTo - range.placeFrom + 1}열`
      items.push({ label: '선택 영역 복사', detail: size, icon: <RiFileCopyLine size={14} />, onSelect: () => onCopy(rangeAsTsv(rows, order, range)) })
    } else {
      // A right-click outside the block selects the cell it is on
      setAnchor({ row, place })
      setFocus({ row, place })
    }
    const index = order[place]
    const cell = rows[row][index]
    const column = columns[index]
    items.push({ label: '셀 복사', icon: <RiFileCopyLine size={14} />, onSelect: () => onCopy(cellText(cell)) })
    const relation = relations?.[index]
    if (hasRelations(relation) && cell !== null) {
      const short = cellText(cell).length > 24 ? `${cellText(cell).slice(0, 24)}…` : cellText(cell)
      items.push({ heading: true, label: '연관 테이블 조회' })
      for (const target of [...relation.to, ...relation.from]) {
        items.push({ label: tableLabel(target), detail: `${target.column} = ${short}`, icon: <RiSearchLine size={14} />, onSelect: () => onLookup?.(target, cell, column) })
      }
    }
    setMenu({ x: event.clientX, y: event.clientY, items })
  }

  return (
    <div className="db-grid" ref={scrollRef} onScroll={onScroll} tabIndex={0} onKeyDown={onKeyDown} role="grid" aria-rowcount={rows.length + 1} aria-colcount={columns.length} aria-multiselectable="true">
      <div className="db-grid-inner" style={{ width: totalWidth, height: (rows.length + 1) * ROW_HEIGHT }}>
        <div className="db-grid-row db-grid-head" role="row" style={{ gridTemplateColumns: template }} onDragLeave={() => setDropAt(null)}>
          <div className="db-grid-cell db-grid-index" role="columnheader">#</div>
          {order.map((index, place) => {
            const column = columns[index]
            const relation = relations?.[index]
            return (
              <div
                key={index}
                className={`db-grid-cell db-grid-header${dropAt === place ? ' is-drop-target' : ''}`}
                role="columnheader"
                title={`${column.name} (${column.type}) · 끌어서 순서 바꾸기`}
                draggable
                onDragStart={(e) => onDragStart(e, place)}
                onDragOver={(e) => onDragOver(e, place)}
                onDrop={(e) => onDrop(e, place)}
                onDragEnd={() => setDropAt(null)}
              >
                <span className="db-grid-header-name">{column.name}</span>
                {hasRelations(relation) && (
                  <button type="button" className="db-grid-link" onClick={(e) => openRelations(e, index)} draggable={false}
                    title="외래 키: 연결된 테이블 보기" aria-label={`${column.name} 열의 외래 키`}>
                    <RiLinksLine size={13} />
                  </button>
                )}
              </div>
            )
          })}
        </div>
        {rows.slice(first, last).map((row, offset) => {
          const rowIndex = first + offset
          const isCurrent = focus?.row === rowIndex
          const isRowInRange = Boolean(range && rowIndex >= range.rowFrom && rowIndex <= range.rowTo)
          return (
            <div key={rowIndex} className={`db-grid-row${isCurrent ? ' is-current' : ''}`} role="row" aria-selected={isCurrent} style={{ gridTemplateColumns: template, top: (rowIndex + 1) * ROW_HEIGHT }}>
              <div
                className="db-grid-cell db-grid-index"
                title="이 행 전체 선택"
                onMouseDown={(e) => {
                  if (e.button !== 0) return
                  // The whole row; with Shift, every row from the anchor's to this one
                  setAnchor({ row: e.shiftKey && anchor ? anchor.row : rowIndex, place: 0 })
                  setFocus({ row: rowIndex, place: lastPlace })
                }}
              >
                {rowIndex + 1}
              </div>
              {order.map((index, place) => {
                const cell = row[index]
                const isFocus = isCurrent && focus?.place === place
                const isInRange = isBlock && isRowInRange && range !== null && place >= range.placeFrom && place <= range.placeTo
                const text = cellText(cell)
                return (
                  <div
                    key={index}
                    role="gridcell"
                    aria-selected={isFocus || isInRange}
                    className={`db-grid-cell${cell === null ? ' is-null' : ''}${typeof cell === 'number' ? ' is-number' : ''}${isInRange ? ' is-in-range' : ''}${isFocus ? ' is-selected' : ''}`}
                    title={text.length > 40 ? text.slice(0, 2000) : undefined}
                    onMouseDown={(e) => {
                      if (e.button !== 0) return
                      isSelecting.current = true
                      select({ row: rowIndex, place }, e.shiftKey)
                    }}
                    onMouseEnter={() => { if (isSelecting.current) setFocus({ row: rowIndex, place }) }}
                    onContextMenu={(e) => openCellMenu(e, rowIndex, place)}
                  >
                    {text}
                  </div>
                )
              })}
            </div>
          )
        })}
      </div>
      {menu && <DbGridMenu x={menu.x} y={menu.y} items={menu.items} onClose={() => setMenu(null)} />}
    </div>
  )
}

/** Tab-separated text of the whole result (header first) for pasting into a spreadsheet */
export function resultAsTsv(columns: DbColumn[], rows: DbCell[][]): string {
  const clean = (text: string): string => text.replace(/[\t\r\n]+/g, ' ')
  const lines = [columns.map(c => clean(c.name)).join('\t'), ...rows.map(r => r.map(cell => clean(cell === null ? '' : String(cell))).join('\t'))]
  return lines.join('\n')
}
