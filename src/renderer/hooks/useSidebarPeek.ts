import { useCallback, useEffect, useLayoutEffect, useRef, useState, type PointerEvent } from 'react'

const OPEN_DELAY_MS = 120
const CLOSE_DELAY_MS = 300
type PeekSection = 'sessions' | 'local'

/** A menu, hover card or name input that belongs to the sidebar is still in use */
function isSidebarBusy(sidebar: HTMLElement | null): boolean {
  if (document.querySelector('[data-radix-popper-content-wrapper], .context-menu, .sidebar-popover')) return true
  return Boolean(sidebar?.querySelector('input:focus'))
}

/**
 * Each half of the folded rail previews one list over the terminal. The preview stays open while
 * the pointer is inside, or while a menu, hover card or input is in use.
 */
export function useSidebarPeek(isFolded: boolean) {
  const [section, setSection] = useState<PeekSection | null>(null)
  const [isOpen, setIsOpen] = useState(false)
  const sidebarRef = useRef<HTMLElement>(null)
  const focusTargetRef = useRef<HTMLButtonElement>(null)
  const timer = useRef<number | undefined>(undefined)
  const isPointerInside = useRef(false)
  const focusOnOpen = useRef(false)

  const clear = () => window.clearTimeout(timer.current)

  const closeWhenIdle = useCallback(() => {
    clear()
    timer.current = window.setTimeout(() => {
      if (isPointerInside.current) return
      if (isSidebarBusy(sidebarRef.current)) closeWhenIdle()
      else setIsOpen(false)
    }, CLOSE_DELAY_MS)
  }, [])

  const onPointerEnter = useCallback((event: PointerEvent) => {
    if (event.pointerType !== 'touch') isPointerInside.current = true
  }, [])

  const onPointerLeave = useCallback((event: PointerEvent) => {
    if (event.pointerType === 'touch') return
    isPointerInside.current = false
    closeWhenIdle()
  }, [closeWhenIdle])

  const open = (next: PeekSection) => {
    setSection(next)
    setIsOpen(true)
  }

  const switchPreview = (next: PeekSection) => {
    clear()
    setSection(next)
  }

  // Tab reaches either rail button. Activating it moves focus into the revealed panel.
  const previewTrigger = (section: PeekSection) => ({
    onPointerEnter: (event: PointerEvent) => {
      if (event.pointerType === 'touch') return
      clear()
      timer.current = window.setTimeout(() => open(section), OPEN_DELAY_MS)
    },
    onClick: () => {
      clear()
      focusOnOpen.current = true
      open(section)
    }
  })
  const peekSection = isFolded ? section : null
  const isPeekOpen = isFolded && isOpen
  useLayoutEffect(() => {
    if (!isPeekOpen || !focusOnOpen.current) return
    focusOnOpen.current = false
    focusTargetRef.current?.focus({ preventScroll: true })
  }, [isPeekOpen])

  const onFocus = useCallback(() => {
    clear()
  }, [])
  const onBlur = useCallback((event: React.FocusEvent) => {
    if (sidebarRef.current?.contains(event.relatedTarget as Node | null)) return
    closeWhenIdle()
  }, [closeWhenIdle])

  // Unfolding for good (or folding by the button) ends the peek
  useEffect(() => {
    clear()
    focusOnOpen.current = false
    setSection(null)
    setIsOpen(false)
    return clear
  }, [isFolded])

  return { sidebarRef, focusTargetRef, peekSection, isPeekOpen, previewTrigger, switchPreview, peekHandlers: isFolded ? { onPointerEnter, onPointerLeave, onFocus, onBlur } : {} }
}
