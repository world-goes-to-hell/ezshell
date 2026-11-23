import { useLayoutEffect, useRef, useState, type KeyboardEvent, type MouseEvent } from 'react'
import { APPROVAL_ARM_DELAY_MS, isApprovalArmed } from '../../lib/approvalArming'

export function useApprovalArming() {
  const [armed, setArmed] = useState(false)
  const ready = useRef(false)

  useLayoutEffect(() => {
    const shownAt = Date.now()
    let focusedAt: number | null = document.hasFocus() ? shownAt : null
    let timer: number | undefined
    const update = () => {
      window.clearTimeout(timer)
      const now = Date.now()
      const hasFocus = document.hasFocus()
      ready.current = isApprovalArmed({ shownAt, focusedAt, hasFocus, now })
      setArmed(ready.current)
      if (hasFocus && focusedAt !== null && !ready.current) {
        timer = window.setTimeout(update, Math.max(shownAt, focusedAt) + APPROVAL_ARM_DELAY_MS - now)
      }
    }
    const onFocus = () => { focusedAt = Date.now(); update() }
    const onBlur = () => { focusedAt = null; update() }
    window.addEventListener('focus', onFocus)
    window.addEventListener('blur', onBlur)
    update()
    return () => {
      window.clearTimeout(timer)
      window.removeEventListener('focus', onFocus)
      window.removeEventListener('blur', onBlur)
    }
  }, [])

  return { armed, canActivate: () => ready.current && document.hasFocus() }
}

export function isApprovalClick(event: MouseEvent<HTMLButtonElement>) {
  return event.detail > 0 || document.activeElement === event.currentTarget
}

export function isApprovalShortcut(event: KeyboardEvent<HTMLDivElement>) {
  if (event.repeat && event.target instanceof HTMLButtonElement && (event.key === 'Enter' || event.key === ' ')) {
    event.preventDefault()
  }
  return !event.defaultPrevented && !event.nativeEvent.isComposing && !event.repeat && !event.ctrlKey && !event.altKey && !event.metaKey
    && event.currentTarget.contains(document.activeElement)
}
