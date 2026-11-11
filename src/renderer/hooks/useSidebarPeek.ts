import { useCallback, useEffect, useRef, useState } from 'react'

const OPEN_DELAY_MS = 120
const CLOSE_DELAY_MS = 300

/** A menu, hover card or name input that belongs to the sidebar is still in use */
function isSidebarBusy(sidebar: HTMLElement | null): boolean {
  if (document.querySelector('[data-radix-popper-content-wrapper], .context-menu')) return true
  return Boolean(sidebar?.querySelector('input:focus'))
}

/**
 * The folded sidebar opens over the terminal while the pointer (or keyboard focus) is on it, and
 * folds again a moment after it leaves. It stays open while one of its menus, hover cards or name
 * inputs is in use: those are drawn outside the sidebar, so moving onto them counts as leaving.
 */
export function useSidebarPeek(isFolded: boolean) {
  const [isOpen, setIsOpen] = useState(false)
  const sidebarRef = useRef<HTMLElement>(null)
  const timer = useRef<number | undefined>(undefined)
  const isPointerInside = useRef(false)

  const clear = () => window.clearTimeout(timer.current)

  const closeWhenIdle = useCallback(() => {
    clear()
    timer.current = window.setTimeout(() => {
      if (isPointerInside.current) return
      if (isSidebarBusy(sidebarRef.current)) closeWhenIdle()
      else setIsOpen(false)
    }, CLOSE_DELAY_MS)
  }, [])

  const onPointerEnter = useCallback(() => {
    isPointerInside.current = true
    clear()
    timer.current = window.setTimeout(() => setIsOpen(true), OPEN_DELAY_MS)
  }, [])

  const onPointerLeave = useCallback(() => {
    isPointerInside.current = false
    closeWhenIdle()
  }, [closeWhenIdle])

  // Keyboard: tabbing into the sidebar opens it, tabbing out folds it
  const onFocus = useCallback(() => {
    clear()
    setIsOpen(true)
  }, [])
  const onBlur = useCallback((event: React.FocusEvent) => {
    if (sidebarRef.current?.contains(event.relatedTarget as Node | null)) return
    closeWhenIdle()
  }, [closeWhenIdle])

  // Unfolding for good (or folding by the button) ends the peek
  useEffect(() => {
    clear()
    setIsOpen(false)
    return clear
  }, [isFolded])

  return { sidebarRef, isPeekOpen: isFolded && isOpen, peekHandlers: isFolded ? { onPointerEnter, onPointerLeave, onFocus, onBlur } : {} }
}
