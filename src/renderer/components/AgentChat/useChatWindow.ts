import { defaultRangeExtractor, useVirtualizer, type Range } from '@tanstack/react-virtual'
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type RefObject } from 'react'
import { QUESTION_BAR_PX } from '../../lib/chatScrollNav'

type Row = { key: string; estimate: number }
type Selection = { anchor: string | null; focus: string | null }

const rowKeyOf = (node: Node | null) => {
  const element = node instanceof Element ? node : node?.parentElement
  return element?.closest<HTMLElement>('[data-chat-row]')?.dataset.chatRow ?? null
}

function selectContents(log: HTMLElement | null) {
  const selection = window.getSelection()
  if (!log || !selection) return
  const range = document.createRange()
  range.selectNodeContents(log)
  selection.removeAllRanges()
  selection.addRange(range)
}

export function useChatWindow(rows: readonly Row[], logRef: RefObject<HTMLDivElement | null>, hasMessages: boolean) {
  const [selection, setSelection] = useState<Selection | null>(null)
  const [selectingAll, setSelectingAll] = useState(false)
  const [focusedRow, setFocusedRow] = useState<string | null>(null)
  const initialized = useRef(false)
  const followNext = useRef(false)
  const indices = useMemo(() => new Map(rows.map((row, index) => [row.key, index])), [rows])
  const rangeExtractor = useCallback((range: Range) => {
    if (selectingAll) return rows.map((_, index) => index)
    const visible = defaultRangeExtractor(range)
    const focused = focusedRow === null ? undefined : indices.get(focusedRow)
    if (!selection && focused === undefined) return visible
    const keep = new Set(visible)
    if (focused !== undefined) keep.add(focused)
    const anchor = selection?.anchor == null ? undefined : indices.get(selection.anchor)
    const focus = selection?.focus == null ? undefined : indices.get(selection.focus)
    if (anchor !== undefined && focus !== undefined) {
      for (let index = Math.min(anchor, focus); index <= Math.max(anchor, focus); index++) keep.add(index)
    }
    return [...keep].sort((a, b) => a - b)
  }, [focusedRow, indices, rows, selectingAll, selection])

  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => logRef.current,
    getItemKey: useCallback((index: number) => rows[index].key, [rows]),
    estimateSize: useCallback((index: number) => rows[index].estimate, [rows]),
    rangeExtractor,
    anchorTo: 'end',
    followOnAppend: true,
    scrollEndThreshold: 40,
    // A question jumped to lands below the bar over the top of the log (chatScrollNav)
    scrollPaddingStart: QUESTION_BAR_PX,
    overscan: 8,
    paddingStart: 12,
    paddingEnd: 16,
    gap: 10
  })

  useLayoutEffect(() => {
    if (!hasMessages || (initialized.current && !followNext.current)) return
    initialized.current = true
    followNext.current = false
    virtualizer.scrollToEnd()
  }, [hasMessages, rows, virtualizer])

  useEffect(() => {
    const changed = () => {
      const log = logRef.current
      const range = window.getSelection()
      if (!log || !range || range.isCollapsed || !log.contains(range.anchorNode) || !log.contains(range.focusNode)) {
        setSelection(null)
        setSelectingAll(false)
        return
      }
      const anchor = rowKeyOf(range.anchorNode)
      const focus = rowKeyOf(range.focusNode)
      setSelection(previous => previous?.anchor === anchor && previous.focus === focus ? previous : { anchor, focus })
    }
    document.addEventListener('selectionchange', changed)
    return () => document.removeEventListener('selectionchange', changed)
  }, [logRef])

  // The explicit Select All action temporarily mounts the full loaded conversation for native selection.
  useLayoutEffect(() => {
    if (selectingAll) selectContents(logRef.current)
  }, [logRef, selectingAll])

  return {
    virtualizer,
    followAfterSend: () => { followNext.current = true },
    rememberFocus: (element: Node | null) => setFocusedRow(element && logRef.current?.contains(element) ? rowKeyOf(element) : null),
    selectAll: () => { if (selectingAll) selectContents(logRef.current); else setSelectingAll(true) }
  }
}
