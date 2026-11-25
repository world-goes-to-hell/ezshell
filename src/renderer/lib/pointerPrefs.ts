// 설정 > 테마 > 마우스 포인터: the pointer set, its size and the two mouse effects. One localStorage
// key for every window; a window follows another one's change through the storage event.
import { CURSOR_SET_IDS, CURSOR_SIZES, type CursorSetId, type CursorSize } from './pointerCursors'

export const POINTER_PREFS_KEY = 'pointerPrefs'

export const MOVE_EFFECTS = ['none', 'spot', 'ghost', 'sparkle', 'rainbow', 'comet', 'bubble', 'petal', 'pixel', 'paw'] as const
export const CLICK_EFFECTS = ['none', 'press', 'ripple', 'pulse', 'heart', 'firework', 'starpop', 'word', 'ink'] as const
export type MoveEffect = typeof MOVE_EFFECTS[number]
export type ClickEffect = typeof CLICK_EFFECTS[number]
export type EffectLevel = 1 | 2 | 3

export interface PointerPrefs {
  set: CursorSetId
  size: CursorSize
  move: MoveEffect
  click: ClickEffect
  moveLevel: EffectLevel
  clickLevel: EffectLevel
  /** Effects over a terminal pane: moving ones are off by default (they get in the way of reading output) */
  moveOnTerminal: boolean
  clickOnTerminal: boolean
  /** The pointer set in other programs too (Windows: replaces the system pointers while the app runs) */
  outsideApp: boolean
}

export const DEFAULT_POINTER_PREFS: PointerPrefs = Object.freeze({
  set: 'system', size: 32, move: 'none', click: 'none', moveLevel: 2, clickLevel: 2, moveOnTerminal: false, clickOnTerminal: true, outsideApp: false
})

const oneOf = <T>(list: readonly T[], value: unknown, fallback: T): T => (list.includes(value as T) ? value as T : fallback)
const flag = (value: unknown, fallback: boolean) => (typeof value === 'boolean' ? value : fallback)

/** Stored text → prefs. Anything unknown or malformed falls back to the default, field by field. */
export function parsePointerPrefs(raw: string | null | undefined): PointerPrefs {
  let value: Record<string, unknown> = {}
  try {
    const parsed: unknown = raw ? JSON.parse(raw) : null
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) value = parsed as Record<string, unknown>
  } catch { /* the defaults */ }
  const d = DEFAULT_POINTER_PREFS
  return {
    set: oneOf(CURSOR_SET_IDS, value.set, d.set),
    size: oneOf(CURSOR_SIZES, value.size, d.size),
    move: oneOf(MOVE_EFFECTS, value.move, d.move),
    click: oneOf(CLICK_EFFECTS, value.click, d.click),
    moveLevel: oneOf([1, 2, 3] as const, value.moveLevel, d.moveLevel),
    clickLevel: oneOf([1, 2, 3] as const, value.clickLevel, d.clickLevel),
    moveOnTerminal: flag(value.moveOnTerminal, d.moveOnTerminal),
    clickOnTerminal: flag(value.clickOnTerminal, d.clickOnTerminal),
    outsideApp: flag(value.outsideApp, d.outsideApp)
  }
}

export const hasEffects = (prefs: PointerPrefs) => prefs.move !== 'none' || prefs.click !== 'none'

const listeners = new Set<(prefs: PointerPrefs) => void>()
let current: PointerPrefs | null = null
let watching = false

function storage(): Storage | null {
  try { return typeof localStorage === 'undefined' ? null : localStorage } catch { return null }
}

function watchOtherWindows() {
  if (watching || typeof window === 'undefined') return
  watching = true
  window.addEventListener('storage', event => {
    if (event.key !== POINTER_PREFS_KEY && event.key !== null) return
    current = parsePointerPrefs(storage()?.getItem(POINTER_PREFS_KEY))
    for (const listener of listeners) listener(current)
  })
}

export function getPointerPrefs(): PointerPrefs {
  if (!current) current = parsePointerPrefs(storage()?.getItem(POINTER_PREFS_KEY))
  return current
}

/** Saves a change and tells this window's listeners (other windows hear the storage event) */
export function setPointerPrefs(patch: Partial<PointerPrefs>): PointerPrefs {
  const next = parsePointerPrefs(JSON.stringify({ ...getPointerPrefs(), ...patch }))
  current = next
  try { storage()?.setItem(POINTER_PREFS_KEY, JSON.stringify(next)) } catch { /* kept for this run */ }
  for (const listener of listeners) listener(next)
  return next
}

export function subscribePointerPrefs(listener: (prefs: PointerPrefs) => void): () => void {
  watchOtherWindows()
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}
