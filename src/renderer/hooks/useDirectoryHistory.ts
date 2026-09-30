import { useCallback, useEffect, useRef, type RefObject } from 'react'
import {
  createDirectoryHistory,
  recordVisit,
  requestStep,
  type HistoryDirection
} from '../lib/directoryHistory'

// MouseEvent.button values for the side (thumb) buttons
const MOUSE_BACK_BUTTON = 3
const MOUSE_FORWARD_BUTTON = 4

const directionOf = (button: number): HistoryDirection | null => {
  if (button === MOUSE_BACK_BUTTON) return 'back'
  if (button === MOUSE_FORWARD_BUTTON) return 'forward'
  return null
}

/**
 * Back/forward directory history for a file list, driven by the mouse thumb buttons.
 * A path is recorded only once loading has finished, so failed navigations are skipped.
 * Also returns `step` for keyboard shortcuts (Alt+Left / Alt+Right).
 */
export function useDirectoryHistory(
  ref: RefObject<HTMLElement | null>,
  currentPath: string,
  isLoading: boolean,
  onNavigate: (path: string) => void
) {
  const historyRef = useRef(createDirectoryHistory())
  const onNavigateRef = useRef(onNavigate)
  onNavigateRef.current = onNavigate

  useEffect(() => {
    if (isLoading) return
    historyRef.current = recordVisit(historyRef.current, currentPath)
  }, [currentPath, isLoading])

  const step = useCallback((direction: HistoryDirection) => {
    const { state, target } = requestStep(historyRef.current, direction)
    if (!target) return
    historyRef.current = state
    onNavigateRef.current(target)
  }, [])

  useEffect(() => {
    const element = ref.current
    if (!element) return

    // Chromium navigates the page history on thumb-button mouseup; block it so the app stays put
    const suppressDefault = (event: MouseEvent) => {
      if (directionOf(event.button)) event.preventDefault()
    }

    const handleMouseUp = (event: MouseEvent) => {
      const direction = directionOf(event.button)
      if (!direction) return
      event.preventDefault()
      step(direction)
    }

    element.addEventListener('mousedown', suppressDefault)
    element.addEventListener('mouseup', handleMouseUp)
    element.addEventListener('auxclick', suppressDefault)
    return () => {
      element.removeEventListener('mousedown', suppressDefault)
      element.removeEventListener('mouseup', handleMouseUp)
      element.removeEventListener('auxclick', suppressDefault)
    }
  }, [ref, step])

  return step
}
