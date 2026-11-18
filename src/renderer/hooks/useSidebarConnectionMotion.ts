import { useLayoutEffect, useRef, type RefObject } from 'react'

interface DotFlights {
  dots: Map<HTMLElement, HTMLElement>
  cancel: () => void
}

function visibleSessionDots(sidebar: HTMLElement) {
  const listBounds = sidebar.querySelector('.session-list')?.getBoundingClientRect()
  if (!listBounds) return []
  return Array.from(sidebar.querySelectorAll('.session-item.active')).flatMap(row => {
    const dot = row.querySelector<HTMLElement>('.session-dot, .session-tab-badge--connected .session-tab-badge-dot')
    if (!dot) return []
    const bounds = dot.getBoundingClientRect()
    const y = bounds.top + bounds.height / 2
    return bounds.width > 0 && y >= Math.max(0, listBounds.top) && y < Math.min(innerHeight, listBounds.bottom)
      ? [{ dot, bounds }] : []
  })
}

/** Merge connected session dots into the rail, or fan them back out to their rows. */
export function useSidebarConnectionMotion(sidebarRef: RefObject<HTMLElement | null>, isCompact: boolean, enabled: boolean) {
  const previous = useRef(isCompact)
  const flights = useRef<DotFlights | null>(null)
  useLayoutEffect(() => () => flights.current?.cancel(), [])

  useLayoutEffect(() => {
    const changed = previous.current !== isCompact
    previous.current = isCompact
    if (!enabled) {
      flights.current?.cancel()
      return
    }
    if (!changed) return

    const interrupted = new Map<HTMLElement, DOMRect>()
    flights.current?.dots.forEach((dot, rowDot) => interrupted.set(rowDot, dot.getBoundingClientRect()))
    flights.current?.cancel()
    const sidebar = sidebarRef.current
    if (!sidebar?.offsetWidth || document.hidden) return
    // The CSS preference applies before React receives the media query change event.
    const style = getComputedStyle(sidebar)
    const duration = Number.parseFloat(style.getPropertyValue('--sidebar-motion-duration'))
    if (!(duration > 0)) return
    const rail = sidebar.querySelector<HTMLElement>('.rail-connection-dot')
    if (!rail) return
    const railBounds = rail.getBoundingClientRect()
    const rows = visibleSessionDots(sidebar)
    if (!railBounds.width || !rows.length) return

    const easing = style.getPropertyValue('--sidebar-motion-ease').trim()
    const radius = railBounds.width / 2
    const dots = new Map<HTMLElement, HTMLElement>()
    const dotsInTransit = 'sidebar-connection-arrival'
    rail.classList.add(dotsInTransit)
    const animations = rows.map(({ dot: row, bounds }) => {
      const start = interrupted.get(row) ?? (isCompact ? bounds : railBounds)
      const end = isCompact ? railBounds : bounds
      const startX = start.left + start.width / 2
      const startY = start.top + start.height / 2
      const endX = end.left + end.width / 2
      const dx = endX - startX
      const dy = end.top + end.height / 2 - startY
      const midpointX = Math.max(5, Math.min(startX, endX) - 10) - startX
      const dot = document.createElement('span')
      dot.className = 'sidebar-connection-flight'
      dot.setAttribute('aria-hidden', 'true')
      dot.style.left = `${startX - radius}px`
      dot.style.top = `${startY - radius}px`
      document.body.append(dot)
      dots.set(row, dot)
      row.classList.add(dotsInTransit)

      return dot.animate([
        { transform: `translate(0, 0) scale(${start.width / railBounds.width})`, boxShadow: '0 0 0 0 transparent' },
        {
          offset: .5,
          transform: `translate(${midpointX}px, ${dy / 2}px) scale(${(start.width + end.width) / (2 * railBounds.width)})`,
          boxShadow: '0 0 11px 3px var(--sidebar-flight-accent)'
        },
        { transform: `translate(${dx}px, ${dy}px) scale(${end.width / railBounds.width})`, boxShadow: '0 0 0 5px transparent' }
      ], { duration, easing })
    })

    const finish = () => {
      if (flights.current?.dots !== dots) return
      rail.classList.remove(dotsInTransit)
      dots.forEach((dot, row) => {
        row.classList.remove(dotsInTransit)
        dot.remove()
      })
      flights.current = null
    }
    flights.current = { dots, cancel: () => {
      animations.forEach(animation => animation.cancel())
      finish()
    } }
    void Promise.all(animations.map(animation => animation.finished)).then(finish, () => {})
  }, [enabled, isCompact, sidebarRef])
}
