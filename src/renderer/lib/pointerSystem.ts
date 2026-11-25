// 설정 > 포인터 모양 > 다른 프로그램에서도 쓰기 (Windows): the main window draws the chosen set to PNGs and
// main puts them in place of the system pointers (src/globalPointer.js checks each one). Only the states that
// have a system pointer go; grab and grabbing stay the system's. Turning it off, or choosing the system set,
// gives the system's own pointers back. Design: docs/plan/2026-11-25-pointer-outside-app.md
import { cursorHotspot, cursorSet, cursorSvg, type CursorSetId, type CursorSize, type CursorState } from './pointerCursors'
import type { PointerPrefs } from './pointerPrefs'

/** The app's states with a system pointer, in main's order (SYSTEM_CURSOR_IDS) */
export const SYSTEM_POINTER_STATES = [
  'default', 'text', 'wait', 'crosshair', 'col-resize', 'row-resize', 'not-allowed', 'pointer', 'progress'
] as const satisfies readonly CursorState[]

/** What should be in place outside the app: a set and size, or null for the system's own pointers */
export function systemPointerTarget(prefs: PointerPrefs): { set: CursorSetId; size: CursorSize } | null {
  return prefs.outsideApp && !cursorSet(prefs.set).system ? { set: prefs.set, size: prefs.size } : null
}

/** A hotspot as whole pixels inside the image (main refuses anything else) */
export function pixelHotspot([x, y]: [number, number], size: number): [number, number] {
  const pixel = (value: number) => Math.min(size - 1, Math.max(0, Math.round(value)))
  return [pixel(x), pixel(y)]
}

export const canReplaceSystemPointer = () => typeof navigator !== 'undefined' && /Windows/.test(navigator.userAgent)

async function pngOf(svg: string, size: number): Promise<string> {
  const url = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml' }))
  try {
    const image = new Image()
    image.src = url
    await image.decode()
    const canvas = document.createElement('canvas')
    canvas.width = size
    canvas.height = size
    canvas.getContext('2d')!.drawImage(image, 0, 0, size, size)
    return canvas.toDataURL('image/png').slice('data:image/png;base64,'.length)
  } finally {
    URL.revokeObjectURL(url)
  }
}

async function cursorsOf(setId: CursorSetId, size: CursorSize) {
  const set = cursorSet(setId)
  return Promise.all(SYSTEM_POINTER_STATES.map(async state => ({
    state, png: await pngOf(cursorSvg(set, state, size), size), hotspot: pixelHotspot(cursorHotspot(set, state, size), size)
  })))
}

/** Follows the preferences from the main window; detached windows leave it to the main one */
export function createSystemPointerSync() {
  let applied: string | null = null
  let generation = 0
  return async function sync(prefs: PointerPrefs) {
    const api = window.electronAPI
    if (!canReplaceSystemPointer() || !api?.pointerSystemApply || !api.pointerSystemRestore) return
    const target = systemPointerTarget(prefs)
    const key = target ? `${target.set}:${target.size}` : null
    if (key === applied) return
    const mine = ++generation
    if (!target) {
      applied = null
      delete document.documentElement.dataset.systemPointer
      await api.pointerSystemRestore()
      return
    }
    const cursors = await cursorsOf(target.set, target.size)
    // A newer choice came while these were drawn: it sends its own
    if (mine !== generation) return
    applied = key
    const accepted = await api.pointerSystemApply({ size: target.size, cursors })
    if (!accepted) applied = null
    // What main did with them, for screen tests and the developer tools
    if (mine === generation) document.documentElement.dataset.systemPointer = accepted ? `${target.set}:${target.size}` : 'refused'
  }
}
