import { placeTooltip } from './tooltipPosition'
import '../styles/tooltip.css'

/**
 * Tooltips drawn by the app in place of the ones the OS draws for `title` (those cannot be styled, so
 * they ignored the theme). One listener for the whole window: while the pointer is on an element with a
 * `title`, the attribute is taken off (so the OS tooltip stays away) and its text is shown in a themed
 * box; the attribute goes back when the pointer leaves. Components keep writing plain `title="..."`.
 */

const SHOW_DELAY_MS = 450
/** Moving to another element this soon after a tooltip closed shows the next one at once */
const WARM_MS = 400
const HELD_ATTR = 'data-held-title'

let box: HTMLDivElement | null = null
let current: Element | null = null
let timer: number | undefined
let closedAt = 0
let observer: MutationObserver | null = null

function ensureBox(): HTMLDivElement {
  if (!box) {
    box = document.createElement('div')
    box.className = 'app-tooltip'
    box.setAttribute('role', 'tooltip')
    document.body.appendChild(box)
  }
  return box
}

/** Takes the title off the element (kept in a data attribute) and returns its text */
function hold(element: Element): string {
  const title = element.getAttribute('title')
  if (title) {
    element.setAttribute(HELD_ATTR, title)
    element.removeAttribute('title')
    // An icon-only button was named by its title: keep that name while the title is away
    if (!element.hasAttribute('aria-label') && !element.textContent?.trim()) {
      element.setAttribute('aria-label', title)
      element.setAttribute('data-held-label', '')
    }
  }
  return element.getAttribute(HELD_ATTR) ?? ''
}

// Titles of the ancestors of the element in use. The OS shows the nearest title it finds going up
// from the pointer: with only the element's own title taken away, a titled ancestor's tooltip came up
// next to ours (a button inside a bar that has a title of its own).
let heldAncestors: Element[] = []

function holdAncestors(element: Element) {
  for (let node = element.parentElement; node; node = node.parentElement) {
    const title = node.getAttribute('title')
    if (title === null) continue
    node.setAttribute(HELD_ATTR, title)
    node.removeAttribute('title')
    heldAncestors.push(node)
  }
}

function releaseAncestors() {
  for (const node of heldAncestors) {
    const held = node.getAttribute(HELD_ATTR)
    if (held !== null && !node.hasAttribute('title')) node.setAttribute('title', held)
    node.removeAttribute(HELD_ATTR)
  }
  heldAncestors = []
}

function release(element: Element) {
  const held = element.getAttribute(HELD_ATTR)
  if (held === null) return
  // React may have written a new title meanwhile (a toggle button): then that one wins
  if (!element.hasAttribute('title')) element.setAttribute('title', held)
  element.removeAttribute(HELD_ATTR)
  if (element.hasAttribute('data-held-label')) {
    element.removeAttribute('data-held-label')
    element.removeAttribute('aria-label')
  }
}

function show(element: Element, text: string) {
  if (!element.isConnected || !text.trim()) return
  const tip = ensureBox()
  tip.textContent = text
  const tabLabel = element.matches('[data-browser-tab] > [data-tab-label]') ? element
    : element.matches('[data-browser-tab]') ? element.querySelector('[data-tab-label]') : null
  tip.classList.toggle('browser-tab-title-tooltip', Boolean(tabLabel && tabLabel.scrollWidth > tabLabel.clientWidth))
  tip.classList.add('is-visible')
  const anchor = element.getBoundingClientRect()
  const at = placeTooltip(anchor, { width: tip.offsetWidth, height: tip.offsetHeight }, { width: window.innerWidth, height: window.innerHeight })
  tip.style.left = `${at.left}px`
  tip.style.top = `${at.top}px`
}

function close() {
  window.clearTimeout(timer)
  observer?.disconnect()
  if (box?.classList.contains('is-visible')) {
    box.classList.remove('is-visible')
    closedAt = Date.now()
  }
  if (current) release(current)
  releaseAncestors()
  current = null
}

function open(element: Element) {
  close()
  current = element
  const text = hold(element)
  holdAncestors(element)
  // The title changed under the pointer (e.g. "열기" became "닫기" after a click): take it again
  observer = observer ?? new MutationObserver(() => {
    if (current?.hasAttribute('title')) {
      const next = hold(current)
      if (box?.classList.contains('is-visible')) show(current, next)
    }
  })
  observer.observe(element, { attributes: true, attributeFilter: ['title'] })
  const delay = Date.now() - closedAt < WARM_MS ? 0 : SHOW_DELAY_MS
  timer = window.setTimeout(() => { if (current === element) show(element, text) }, delay)
}

function titled(target: EventTarget | null): Element | null {
  // The nearest titled element, whether its title is in place or held (ours, or a held ancestor)
  return target instanceof Element ? target.closest(`[title], [${HELD_ATTR}]`) : null
}

let isInstalled = false

/** Call once per window, before the app renders */
export function installThemedTooltips() {
  if (isInstalled || typeof document === 'undefined') return
  isInstalled = true

  document.addEventListener('pointerover', event => {
    if (event.pointerType === 'touch') return
    const element = titled(event.target)
    if (element === current) return
    if (element) open(element)
    else close()
  })
  // A click acts on the button; the hint is in the way from then on (same as the OS tooltip)
  document.addEventListener('pointerdown', () => {
    window.clearTimeout(timer)
    box?.classList.remove('is-visible')
  }, true)
  document.addEventListener('keydown', close, true)
  document.addEventListener('scroll', close, true)
  // The pointer left the window, or the element under it was removed (a menu closed): no element
  // will report "pointer out" for those
  document.documentElement.addEventListener('mouseleave', close)
  document.addEventListener('pointermove', () => { if (current && !current.isConnected) close() }, true)
  window.addEventListener('blur', close)
}
