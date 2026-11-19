const DURATION_MS = 460
const TAB_LOOKUP_MS = 250
const CHIP_HEIGHT = 25
const CHIP_PADDING = 7
const REDUCED_MOTION_QUERY = '(prefers-reduced-motion: reduce)'

interface TabFlightSource {
  bounds: DOMRect
  text: string
}

const nextFrame = () => new Promise<void>(resolve => requestAnimationFrame(() => resolve()))

function canSee(rect: DOMRect, frame: Element | null): boolean {
  const bounds = frame?.getBoundingClientRect()
  const x = rect.left + rect.width / 2
  const y = rect.top + rect.height / 2
  return rect.width > 0 && rect.height > 0 && x >= Math.max(0, bounds?.left ?? 0) &&
    x < Math.min(innerWidth, bounds?.right ?? innerWidth) && y >= Math.max(0, bounds?.top ?? 0) &&
    y < Math.min(innerHeight, bounds?.bottom ?? innerHeight)
}

/** The tab may be scaling in. Land at the title's layout position at full scale. */
function titlePosition(tab: HTMLElement, label: DOMRect) {
  const box = tab.getBoundingClientRect()
  const sx = box.width / tab.offsetWidth
  const sy = box.height / tab.offsetHeight
  return {
    x: box.left + box.width / 2 + (label.left - box.left - box.width / 2) / sx,
    y: box.top + box.height / 2 + (label.top + label.height / 2 - box.top - box.height / 2) / sy
  }
}

/** Capture the launch control before opening its tab changes the layout. */
export function captureTabFlightSource(source: Element | null, frame: Element | null = null): TabFlightSource | null {
  if (!source || document.hidden || matchMedia(REDUCED_MOTION_QUERY).matches) return null
  const label = source.textContent?.trim() || source.getAttribute('aria-label')
  if (!label) return null
  const bounds = source.getBoundingClientRect()
  return canSee(bounds, frame) ? { bounds, text: label } : null
}

export async function flyToTab(source: TabFlightSource, sessionId: string): Promise<void> {
  const reduced = matchMedia(REDUCED_MOTION_QUERY)
  if (reduced.matches || document.hidden) return
  const selector = `:is(.terminal-tab, .split-pane-tab-item)[data-tab-id="${CSS.escape(sessionId)}"]`
  const deadline = performance.now() + TAB_LOOKUP_MS
  let tab: HTMLElement | null
  // In the split view, a new tab can move into the active strip just after the first commit.
  await nextFrame()
  do {
    await nextFrame()
    if (reduced.matches || document.hidden || performance.now() > deadline) return
    tab = document.querySelector<HTMLElement>(selector)
  } while (!tab)

  const label = tab.querySelector('[data-tab-label]')
  if (!label || !tab.offsetWidth || !tab.offsetHeight) return
  const from = source.bounds

  // Only the split strip scrolls horizontally. Reveal its new tab before measuring the destination.
  const strip = tab.closest<HTMLElement>('.split-pane-tabs')
  if (strip) {
    const bounds = strip.getBoundingClientRect()
    const box = tab.getBoundingClientRect()
    if (box.right > bounds.right) strip.scrollLeft += box.right - bounds.right
    else if (box.left < bounds.left) strip.scrollLeft += box.left - bounds.left
  }
  const to = label.getBoundingClientRect()
  if (!canSee(to, tab.closest('.terminal-tabs, .split-pane-tabs'))) return

  const destination = titlePosition(tab, to)
  const dx = destination.x - from.left
  const dy = destination.y - (from.top + from.height / 2)
  const lift = Math.min(42, Math.max(10, Math.hypot(dx, dy) * .1))
  const ghost = document.createElement('div')
  ghost.className = 'session-tab-flight'
  ghost.setAttribute('aria-hidden', 'true')
  ghost.dataset.destinationId = sessionId
  ghost.textContent = source.text
  ghost.style.left = `${from.left - CHIP_PADDING}px`
  ghost.style.top = `${from.top + (from.height - CHIP_HEIGHT) / 2}px`
  ghost.style.maxWidth = `${Math.min(from.width, 220) + 2 * CHIP_PADDING}px`

  const frames = [0, .2, .4, .6, .8, .9, 1].map(offset => {
    const progress = 1 - (1 - offset) ** 2
    return {
      offset,
      transform: `translate3d(${dx * progress}px, ${dy * progress - 2 * lift * progress * (1 - progress)}px, 0)`,
      opacity: offset <= .8 ? 1 : (1 - offset) * 5
    }
  })
  document.body.append(ghost)
  const flight = ghost.animate(frames, { duration: DURATION_MS, fill: 'both' })
  label.classList.add('session-tab-receiver')
  const cancel = () => flight.cancel()
  reduced.addEventListener('change', cancel)
  document.addEventListener('visibilitychange', cancel)
  const width = innerWidth
  const height = innerHeight
  const onResize = () => { if (width !== innerWidth || height !== innerHeight) cancel() }
  window.addEventListener('resize', onResize)
  try {
    await flight.finished
  } catch {
    // The tab label is restored even when the window changes while the chip is moving.
  } finally {
    reduced.removeEventListener('change', cancel)
    document.removeEventListener('visibilitychange', cancel)
    window.removeEventListener('resize', onResize)
    label.classList.remove('session-tab-receiver')
    ghost.remove()
  }
}
