import { useEffect, useRef, useState, type RefObject } from 'react'
import { commitPaneGesture, type PaneGestureAction } from '../lib/paneGesture'
import { layoutOf, leafAt, leafCount, paneLimitReached, mergePaneLayout, singlePane, type PaneId } from '../lib/splitTree'
import { splitGestureLine } from '../lib/paneDropZones'
import { scribbleTurns, SCRIBBLE_TURNS } from '../lib/paneScribble'
import { useTerminalStore } from '../stores/terminalStore'
import { toast } from '../stores/toastStore'
import { isTabHostPreviewed } from '../lib/tabHosts'

const TRAIL_MS = 380
export const PANE_GESTURE_CANCEL_RADIUS = 22

interface Drag {
  pointer: number
  from: PaneId
  rect: DOMRect
  context: CanvasRenderingContext2D
  x: number
  y: number
  start: { x: number; y: number }
  leftPane: boolean
  canReturnToCancel: boolean
  /** The stroke so far; a scribble counts only the points since it was last outside its pane */
  points: Array<{ x: number; y: number }>
  scribbleFrom: number
  turns: number
  /** A recognized scribble stays armed inside the pane, including while hovering over the cancel target. */
  scribble: boolean
}

interface GesturePreview {
  from: PaneId
  action: PaneGestureAction | null
  cancelTarget: { x: number; y: number; labelX: number; above: boolean; active: boolean } | null
}

function isNearStart({ x, y, start }: Drag): boolean {
  return Math.hypot(x - start.x, y - start.y) <= PANE_GESTURE_CANCEL_RADIUS
}

/** Hide the split or merge cancel target once the stroke starts to look like a scribble. */
function canCancelSplitOrMerge(drag: Drag): boolean {
  return drag.canReturnToCancel && drag.turns < SCRIBBLE_TURNS - 1
}

const refit = () => requestAnimationFrame(() => window.dispatchEvent(new Event('resize')))
const FAILURES = { merge: '분할 칸을 병합하지 못했습니다', split: '터미널을 분할하지 못했습니다', close: '칸을 닫지 못했습니다' } as const

/** Alt+drag is captured before xterm starts a text selection or sends a mouse event to the shell. */
export function usePaneGesture(tabId: string, container: RefObject<HTMLDivElement | null>) {
  const canvas = useRef<HTMLCanvasElement>(null)
  const [trail, setTrail] = useState<'active' | 'fading' | null>(null)
  const [preview, setPreview] = useState<GesturePreview | null>(null)

  useEffect(() => {
    const root = container.current
    if (!root) return
    let drag: Drag | null = null
    let hide = 0
    let moving = false
    let disposed = false
    const tabOf = () => useTerminalStore.getState().terminals.get(tabId)

    const actionAt = (gesture: Drag): PaneGestureAction | null => {
      const tab = tabOf()
      if (!tab) return null
      const tree = tab.splitTree ?? singlePane()
      const kind = tab.local ? 'local' : 'ssh'
      const { width, height } = gesture.rect
      const target = leafAt(layoutOf(tree), gesture.x / width, gesture.y / height)
      if (target?.pane !== gesture.from) {
        gesture.leftPane = true
        gesture.scribble = false
        gesture.turns = 0
        gesture.scribbleFrom = gesture.points.length
      } else if (!gesture.leftPane && !gesture.scribble) {
        gesture.turns = scribbleTurns(gesture.points.slice(gesture.scribbleFrom))
        gesture.scribble = gesture.turns >= SCRIBBLE_TURNS
      }
      if (gesture.scribble) return leafCount(tree) > 1 ? { kind: 'close' } : null
      if (!target || target.isVacant) return null
      if (target.pane !== gesture.from) {
        const merge = mergePaneLayout(tree, gesture.from, target.pane, tab.paneSeq, kind)
        return merge ? { kind: 'merge', to: target.pane, expanded: merge.expanded } : null
      }
      if (gesture.leftPane || paneLimitReached(tree, kind)) return null
      const { x, y, w, h } = target.rect
      const line = splitGestureLine({ x: x * width, y: y * height, w: w * width, h: h * height }, gesture.start, gesture)
      return line ? { kind: 'split', ...line } : null
    }

    const gestureAtPointer = (gesture: Drag) => {
      const nearStart = isNearStart(gesture)
      // Returning to the start lets the user redraw in the source pane after a merge preview.
      if (nearStart && canCancelSplitOrMerge(gesture)) gesture.leftPane = false
      const action = actionAt(gesture)
      if (action && !nearStart) gesture.canReturnToCancel = true
      const canCancel = action?.kind === 'close' || canCancelSplitOrMerge(gesture)
      const cancelling = canCancel && nearStart
      return { action: cancelling ? null : action, canCancel, cancelling }
    }

    const drawTo = (gesture: Drag, x: number, y: number) => {
      const { context, rect } = gesture
      context.beginPath()
      context.moveTo(gesture.x, gesture.y)
      gesture.x = x - rect.left
      gesture.y = y - rect.top
      context.lineTo(gesture.x, gesture.y)
      context.stroke()
      gesture.points.push({ x: gesture.x, y: gesture.y })
    }

    const consume = (event: Event) => {
      event.preventDefault()
      event.stopPropagation()
    }

    const onMove = (event: PointerEvent) => {
      if (!drag || event.pointerId !== drag.pointer) return
      consume(event)
      drawTo(drag, event.clientX, event.clientY)
      const { action, canCancel, cancelling } = gestureAtPointer(drag)
      const { start, rect } = drag
      const labelInset = Math.min(64, rect.width / 2)
      setPreview({
        from: drag.from,
        action,
        cancelTarget: canCancel ? {
          ...start,
          labelX: Math.min(rect.width - labelInset, Math.max(labelInset, start.x)),
          above: rect.height - start.y < PANE_GESTURE_CANCEL_RADIUS + 32,
          active: cancelling
        } : null
      })
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
      const { action, cancelling } = gestureAtPointer(drag)
      if (cancelling) {
        stop(false)
        return
      }
      const { from } = drag
      const scribbled = drag.scribble
      stop(true)
      if (!action) {
        if (scribbled) toast.info('칸을 닫지 않았습니다', '칸이 하나뿐인 탭은 탭 닫기로 닫아 주세요.')
        return
      }
      moving = true
      const failure = FAILURES[action.kind]
      const isVisible = () => !disposed && !isTabHostPreviewed(tabId) && root.isConnected && getComputedStyle(root).visibility === 'visible'
      void commitPaneGesture(tabId, from, action, isVisible).then(result => {
        if (result && !result.ok) toast.error(failure, result.error)
        else if (result && action.kind === 'close') refit()
      }).catch(() => toast.error(failure, '잠시 후 다시 시도해 주세요.'))
        .finally(() => { moving = false })
    }

    const onDown = (event: PointerEvent) => {
      if (!event.altKey || event.button !== 0 || drag || moving || isTabHostPreviewed(tabId)) return
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
      drag = { pointer: event.pointerId, from, rect, context, ...start, start, leftPane: false, canReturnToCancel: false, points: [start], scribbleFrom: 0, turns: 0, scribble: false }
      setTrail('active')
      setPreview({ from, action: null, cancelTarget: null })
      window.addEventListener('pointermove', onMove, true)
      window.addEventListener('pointerup', onUp, true)
      window.addEventListener('pointercancel', cancel)
      window.addEventListener('keydown', escape, true)
      window.addEventListener('blur', cancel)
      window.addEventListener('resize', cancel)
    }

    root.addEventListener('pointerdown', onDown, true)
    return () => {
      disposed = true
      root.removeEventListener('pointerdown', onDown, true)
      cancel()
      window.clearTimeout(hide)
    }
  }, [container, tabId])

  return { canvas, preview, trail }
}
