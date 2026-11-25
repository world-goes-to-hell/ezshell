// Puts the pointer preferences to use in this window (main.tsx: every window of the app's page).
//
// Pointer images: the page's CSP allows images from 'self' and blob: only (no data:), so each SVG
// becomes a Blob once and its blob: URL is reused. The images go in :root custom properties; the
// build rewrote every `cursor: <keyword>` of the app's CSS to read them (scripts/postcss-cursor-vars.cjs).
//
// Effects: one canvas over the whole window that never takes the pointer. It and its listeners exist
// only while an effect is chosen; its frame loop runs only while something is left to draw, and stops
// while the window is hidden or not focused (the canvas then holds no pixels). Whether the pointer is
// over a terminal is read from each event's target when a particle starts; nothing is cut out of the
// canvas, because terminals can be covered by the chat view, dialogs or menus.
import '../styles/pointerCursors.css'
import {
  CURSOR_STATES, cursorHotspot, cursorSet, cursorSvg, cursorValue, cursorVariable, type CursorSetId, type CursorSize, type CursorState
} from './pointerCursors'
import { getPointerPrefs, hasEffects, subscribePointerPrefs, type PointerPrefs } from './pointerPrefs'
import {
  addClick, addMove, clearEffects, createEffectState, drawFrame, effectiveEffects, keepRunning, pageAllowsEffects, prune, type EffectConfig, type GhostCursor
} from './pointerEffects'
import { effectInk } from './pointerInk'
import { createSystemPointerSync } from './pointerSystem'

const urls = new Map<string, string>()
const ghostCursors = new Map<string, GhostCursor>()

/** The blob: URL of one pointer image, made the first time it is asked for */
export function cursorImageUrl(setId: CursorSetId, state: typeof CURSOR_STATES[number], size: number): string {
  const key = `${setId}:${state}:${size}`
  let url = urls.get(key)
  if (!url) {
    url = URL.createObjectURL(new Blob([cursorSvg(cursorSet(setId), state, size)], { type: 'image/svg+xml' }))
    urls.set(key, url)
  }
  return url
}

export function ghostCursor(set: CursorSetId, state: CursorState, size: CursorSize): GhostCursor {
  const url = cursorImageUrl(set, state, size)
  let cursor = ghostCursors.get(url)
  if (!cursor) {
    const image = new Image()
    image.src = url
    cursor = { image, hotspot: cursorHotspot(cursorSet(set), state, size) }
    ghostCursors.set(url, cursor)
  }
  return cursor
}

function autoCursor(target: Element, x: number, y: number): CursorState {
  if (target.closest('a:any-link')) return 'pointer'
  if ((target instanceof HTMLElement && target.isContentEditable) ||
    target.matches('textarea:not(:disabled), input:not(:disabled):is(:not([type]), [type=text], [type=search], [type=password], [type=email], [type=url], [type=tel], [type=number])')) return 'text'
  const range = document.caretRangeFromPoint(x, y)
  if (!range) return 'default'
  const node = range.startContainer
  if (node.nodeType !== Node.TEXT_NODE || !node.parentElement || getComputedStyle(node.parentElement).userSelect === 'none') return 'default'
  // A caret can snap to the nearest line even over whitespace. Only glyph bounds make it text.
  range.selectNodeContents(node)
  return [...range.getClientRects()].some(rect => x >= rect.left && x < rect.right && y >= rect.top && y < rect.bottom)
    ? 'text' : 'default'
}

function ghostAt(event: PointerEvent, prefs: PointerPrefs): GhostCursor | null {
  const target = event.target
  if (!(target instanceof Element)) return null
  const computed = getComputedStyle(target).cursor
  const fallback = computed.slice(computed.lastIndexOf(',') + 1).trim()
  const state = fallback === 'auto' ? autoCursor(target, event.clientX, event.clientY) : CURSOR_STATES.find(state => state === fallback)
  if (!state) return null
  const custom = prefs.set !== 'system' && computed.includes(cursorImageUrl(prefs.set, state, prefs.size))
  return custom ? ghostCursor(prefs.set, state, prefs.size) : ghostCursor('system', state, 32)
}

function applyCursors(setId: CursorSetId, size: CursorSize) {
  const root = document.documentElement
  const set = cursorSet(setId)
  if (set.system) {
    delete root.dataset.cursorSet
    for (const state of CURSOR_STATES) root.style.removeProperty(cursorVariable(state))
    return
  }
  for (const state of CURSOR_STATES) {
    root.style.setProperty(cursorVariable(state), cursorValue(cursorImageUrl(setId, state, size), cursorHotspot(set, state, size), state))
  }
  root.dataset.cursorSet = setId
}

/** Over a terminal pane (its xterm element): read from the event target, not by searching the page */
const overTerminal = (target: EventTarget | null) => target instanceof Element && target.closest('.xterm') !== null

let motionQuery: MediaQueryList | null = null
const reducedMotion = () => {
  if (typeof matchMedia !== 'function') return false
  motionQuery ??= matchMedia('(prefers-reduced-motion: reduce)')
  return motionQuery.matches
}

function createOverlay(initial: PointerPrefs) {
  let prefs = initial
  const canvas = document.createElement('canvas')
  canvas.className = 'pointer-effects-canvas'
  canvas.setAttribute('aria-hidden', 'true')
  document.body.appendChild(canvas)
  const ctx = canvas.getContext('2d')!
  const state = createEffectState()
  let frame = 0
  let last = 0
  let ink: { ink: string; dark: boolean } | null = null
  let size = { width: 0, height: 0 }
  // The backing store is sized only while something is drawn (0×0 when stopped gives its memory back)
  let sized = false
  let resolution: MediaQueryList | null = null

  const config = (): EffectConfig => {
    ink ??= effectInk(getComputedStyle(document.documentElement))
    const reduced = reducedMotion()
    const effects = effectiveEffects(prefs.move, prefs.click, reduced)
    return {
      reduced, dark: ink.dark, ink: ink.ink, move: effects.move, click: effects.click,
      moveLevel: prefs.moveLevel, clickLevel: prefs.clickLevel, moveOnTerminal: prefs.moveOnTerminal, clickOnTerminal: prefs.clickOnTerminal
    }
  }
  const page = () => ({ hidden: document.hidden, focused: document.hasFocus() })
  const running = () => pageAllowsEffects(page())

  const resize = () => {
    const dpr = Math.min(2, window.devicePixelRatio || 1)
    size = { width: window.innerWidth, height: window.innerHeight }
    canvas.width = Math.round(size.width * dpr)
    canvas.height = Math.round(size.height * dpr)
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    sized = true
    // A move to a screen with another scale, or a zoom change: size again
    resolution?.removeEventListener('change', onResolution)
    resolution = matchMedia(`(resolution: ${window.devicePixelRatio || 1}dppx)`)
    resolution.addEventListener('change', onResolution)
  }
  const onResolution = () => { if (sized) resize() }
  const onResize = () => { if (sized) resize() }

  const tick = (time: number) => {
    frame = 0
    const dt = Math.max(0, Math.min(40, time - last))
    last = time
    const c = config()
    drawFrame(ctx, state, size.width, size.height, time, dt, c)
    if (keepRunning(state, c, page())) frame = requestAnimationFrame(tick)
    else release()
  }
  const wake = () => {
    if (frame || !running()) return
    if (!sized) resize()
    last = performance.now()
    frame = requestAnimationFrame(tick)
  }
  /** Nothing left to draw (or the window went away): the canvas gives its memory back */
  const release = () => {
    if (frame) cancelAnimationFrame(frame)
    frame = 0
    canvas.width = 0
    canvas.height = 0
    sized = false
  }
  const stop = () => {
    clearEffects(state)
    release()
  }

  const onMove = (event: PointerEvent) => {
    if (!running()) return
    const c = config()
    if (c.move === 'none') return
    const visible = c.moveOnTerminal || !overTerminal(event.target)
    // Over a terminal with moving effects off there is nothing to add; the spotlight hides without frames
    if (!visible && c.move !== 'spot') return
    addMove(state, c.move, event.clientX, event.clientY, performance.now(), c.moveLevel, c.ink, c.dark, visible,
      c.move === 'ghost' ? () => ghostAt(event, prefs) : undefined)
    if (visible || frame) wake()
  }
  const onDown = (event: PointerEvent) => {
    if (!running()) return
    const c = config()
    if (c.click === 'none' || (!c.clickOnTerminal && overTerminal(event.target))) return
    addClick(state, c.click, event.clientX, event.clientY, performance.now(), c.clickLevel, c.ink, c.dark)
    wake()
  }
  const onLeave = () => { state.spot.visible = false; wake() }
  const onPause = () => { if (!running()) stop() }
  // A theme change: the accent is read again on the next frame
  const themeWatch = new MutationObserver(() => { ink = null })
  themeWatch.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme', 'style', 'class'] })

  window.addEventListener('resize', onResize)
  window.addEventListener('pointermove', onMove, { capture: true, passive: true })
  window.addEventListener('pointerdown', onDown, { capture: true, passive: true })
  document.documentElement.addEventListener('mouseleave', onLeave)
  document.addEventListener('visibilitychange', onPause)
  window.addEventListener('blur', onPause)

  return {
    update(next: PointerPrefs) {
      if (next.move !== prefs.move) { state.move = []; state.spot.visible = false }
      if (next.click !== prefs.click) state.click = []
      prefs = next
      prune(state, performance.now())
      wake()
    },
    destroy() {
      stop()
      themeWatch.disconnect()
      resolution?.removeEventListener('change', onResolution)
      window.removeEventListener('resize', onResize)
      window.removeEventListener('pointermove', onMove, { capture: true })
      window.removeEventListener('pointerdown', onDown, { capture: true })
      document.documentElement.removeEventListener('mouseleave', onLeave)
      document.removeEventListener('visibilitychange', onPause)
      window.removeEventListener('blur', onPause)
      canvas.remove()
    }
  }
}

let installed = false

export function installPointerAppearance(): void {
  if (installed || typeof document === 'undefined') return
  installed = true
  let overlay: ReturnType<typeof createOverlay> | null = null
  // Other programs' pointers: the main window only (detached windows open with a ...Mode parameter)
  const mainWindow = ![...new URLSearchParams(location.search).keys()].some(key => key.endsWith('Mode'))
  const syncSystemPointer = mainWindow ? createSystemPointerSync() : null
  const apply = (prefs: PointerPrefs) => {
    applyCursors(prefs.set, prefs.size)
    void syncSystemPointer?.(prefs).catch(() => {})
    if (!hasEffects(prefs)) {
      overlay?.destroy()
      overlay = null
    } else if (overlay) {
      overlay.update(prefs)
    } else {
      overlay = createOverlay(prefs)
    }
  }
  apply(getPointerPrefs())
  subscribePointerPrefs(apply)
}
