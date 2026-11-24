// A tab strip that scrolls sideways: the mouse wheel moves it, the active tab is kept in sight, and the
// strip says which ends hide tabs (data-overflow-start / data-overflow-end, for the edge fades in CSS).
// Returns a callback ref: the strip mounts later than its component (no tabs yet, a split screen).
import { useEffect, useState } from 'react'
import { stripOverflow, wheelScroll } from '../lib/tabStrip'

export function useTabStripScroll<T extends HTMLElement = HTMLDivElement>(activeId: string | null | undefined) {
  const [strip, setStrip] = useState<T | null>(null)

  useEffect(() => {
    if (!strip) return
    // Set on the element directly: a re-render per scroll event is not needed for two attributes
    const measure = () => {
      const { start, end } = stripOverflow(strip.scrollLeft, strip.clientWidth, strip.scrollWidth)
      strip.toggleAttribute('data-overflow-start', start)
      strip.toggleAttribute('data-overflow-end', end)
    }
    // Once per frame: a tab animating in changes its style on every frame
    let frame = 0
    const update = () => {
      if (frame) return
      frame = requestAnimationFrame(() => { frame = 0; measure() })
    }
    const onWheel = (event: WheelEvent) => {
      const delta = wheelScroll(event, strip.scrollWidth <= strip.clientWidth)
      if (delta === null) return
      event.preventDefault()
      strip.scrollLeft += delta
    }
    strip.addEventListener('scroll', update, { passive: true })
    strip.addEventListener('wheel', onWheel, { passive: false })
    const resize = new ResizeObserver(update)
    resize.observe(strip)
    // Tabs come and go (and animate their width) without the strip itself resizing
    const children = new MutationObserver(update)
    children.observe(strip, { childList: true, subtree: true, attributes: true, attributeFilter: ['style', 'class'] })
    measure()
    return () => {
      cancelAnimationFrame(frame)
      strip.removeEventListener('scroll', update)
      strip.removeEventListener('wheel', onWheel)
      resize.disconnect()
      children.disconnect()
    }
  }, [strip])

  useEffect(() => {
    if (!strip || !activeId) return
    const reveal = () => {
      const tab = strip.querySelector<HTMLElement>(`[data-tab-id="${CSS.escape(activeId)}"]`)
      tab?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
    }
    // After the frame that lays out a new tab, and again when its entry animation (a spring, about
    // 0.3s) has given it its full width
    const frame = requestAnimationFrame(reveal)
    const settled = window.setTimeout(reveal, 400)
    return () => {
      cancelAnimationFrame(frame)
      window.clearTimeout(settled)
    }
  }, [strip, activeId])

  return setStrip
}
