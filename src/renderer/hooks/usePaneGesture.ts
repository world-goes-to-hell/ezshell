import { useEffect, useRef, useState, type RefObject } from 'react'
import { mergePanes } from '../lib/paneToTab'
import { layoutOf, leafAt, leafCount, MAX_PANES, mergePaneLayout, singlePane, type PaneId, type Rect, type SplitAxis } from '../lib/splitTree'
import { splitGestureLine } from '../lib/paneDropZones'
import { useTerminalStore } from '../stores/terminalStore'
import { toast } from '../stores/toastStore'

const TRAIL_MS = 380

interface Drag {
  pointer: number
  from: PaneId
  rect: DOMRect
  context: CanvasRenderingContext2D
  x: number
  y: number
  start: { x: number; y: number }
  leftPane: boolean
}

type GestureAction = { kind: 'merge'; to: PaneId; expanded: Rect } | { kind: 'split'; axis: SplitAxis; ratio: number }

/** Alt+drag is captured before xterm starts a text selection or sends a mouse event to the shell. */
export function usePaneGesture(tabId: string, container: RefObject<HTMLDivElement | null>) {
  const canvas = useRef<HTMLCanvasElement>(null)
  const [trail, setTrail] = useState<'active' | 'fading' | null>(null)
  const [preview, setPreview] = useState<{ from: PaneId; action: GestureAction | null } | null>(null)

  useEffect(() => {
    const root = container.current
    if (!root) return
    let drag: Drag | null = null
    let hide = 0
    let moving = false
    const tabOf = () => useTerminalStore.getState().terminals.get(tabId)

    const actionAt = (gesture: Drag): GestureAction | null => {
      const tab = tabOf()
      if (!tab) return null
      const tree = tab.splitTree ?? singlePane()
      const { width, height } = gesture.rect
      const target = leafAt(layoutOf(tree), gesture.x / width, gesture.y / height)
      if (target?.pane !== gesture.from) gesture.leftPane = true
      if (!target || target.isVacant) return null
      if (target.pane !== gesture.from) {
        const merge = mergePaneLayout(tree, gesture.from, target.pane, tab.paneSeq)
        return merge ? { kind: 'merge', to: target.pane, expanded: merge.expanded } : null
      }
      if (gesture.leftPane || leafCount(tree) >= MAX_PANES) return null
      const { x, y, w, h } = target.rect
      const line = splitGestureLine({ x: x * width, y: y * height, w: w * width, h: h * height }, gesture.start, gesture)
      return line ? { kind: 'split', ...line } : null
    }

    const drawTo = (gesture: Drag, x: number, y: number) => {
      const { context, rect } = gesture
      context.beginPath()
      context.moveTo(gesture.x, gesture.y)
      gesture.x = x - rect.left
      gesture.y = y - rect.top
      context.lineTo(gesture.x, gesture.y)
      context.stroke()
    }

    const consume = (event: Event) => {
      event.preventDefault()
      event.stopPropagation()
    }

    const onMove = (event: PointerEvent) => {
      if (!drag || event.pointerId !== drag.pointer) return
      consume(event)
      drawTo(drag, event.clientX, event.clientY)
      setPreview({ from: drag.from, action: actionAt(drag) })
    }

    const stop = (fade: boolean) => {
      drag = null
      setPreview(null)
      setTrail(fade ? 'fading' : null)
      if (fade) hide = window.setTimeout(() => setTrail(null), TRAIL_MS)
      window.removeEventListener('pointermove', onMove, true)
      window.removeEventListener('pointerup', onUp, true)
      window.removeEventListener('pointercancel', cancel)
      window.removeEventListener('keydown', escape, true)
      window.removeEventListener('blur', cancel)
      window.removeEventListener('resize', cancel)
    }

    const cancel = () => { if (drag) stop(false) }
    const escape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      consume(event)
      cancel()
    }
    const onUp = (event: PointerEvent) => {
      if (!drag || event.pointerId !== drag.pointer) return
      consume(event)
      drawTo(drag, event.clientX, event.clientY)
      const { from } = drag
      const action = actionAt(drag)
      stop(true)
      if (!action) return
      if (action.kind === 'split') {
        useTerminalStore.getState().splitTerminalPane(tabId, from, action.axis, action.ratio)
        return
      }
      moving = true
      void mergePanes(tabId, from, action.to).then(result => {
        if (!result.ok) toast.error('분할 칸을 병합하지 못했습니다', result.error)
      }).catch(() => toast.error('분할 칸을 병합하지 못했습니다', '잠시 후 다시 시도해 주세요.'))
        .finally(() => { moving = false })
    }

    const onDown = (event: PointerEvent) => {
      if (!event.altKey || event.button !== 0 || drag || moving) return
      const path = canvas.current
      const terminal = event.target instanceof Element ? event.target.closest<HTMLElement>('[data-pane]') : null
      const from = terminal?.dataset.pane
      if (!tabOf() || !path || !from || !root.contains(terminal)) return
      const rect = root.getBoundingClientRect()
      if (!rect.width || !rect.height) return
      const density = Math.min(window.devicePixelRatio || 1, 2)
      path.width = Math.ceil(rect.width * density)
      path.height = Math.ceil(rect.height * density)
      const context = path.getContext('2d')
      if (!context) return

      consume(event)
      window.clearTimeout(hide)
      context.scale(density, density)
      context.strokeStyle = getComputedStyle(root).getPropertyValue('--accent').trim()
      context.lineWidth = 2.5
      context.lineCap = 'round'
      const start = { x: event.clientX - rect.left, y: event.clientY - rect.top }
      drag = { pointer: event.pointerId, from, rect, context, ...start, start, leftPane: false }
      setTrail('active')
      setPreview({ from, action: null })
      window.addEventListener('pointermove', onMove, true)
      window.addEventListener('pointerup', onUp, true)
      window.addEventListener('pointercancel', cancel)
      window.addEventListener('keydown', escape, true)
      window.addEventListener('blur', cancel)
      window.addEventListener('resize', cancel)
    }

    root.addEventListener('pointerdown', onDown, true)
    return () => {
      root.removeEventListener('pointerdown', onDown, true)
      cancel()
      window.clearTimeout(hide)
    }
  }, [container, tabId])

  return { canvas, preview, trail }
}
