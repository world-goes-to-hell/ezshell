import { cursorHotspot, cursorSet, cursorSvg, type CursorSetId, type CursorSize, type CursorState } from './pointerCursors'
import type { GhostCursor } from './pointerEffects'

const urls = new Map<string, string>()
const ghosts = new Map<string, GhostCursor>()

/** Use the same cached pointer image for CSS, previews and ghost particles. */
export function cursorImageUrl(set: CursorSetId, state: CursorState, size: number): string {
  const key = `${set}:${state}:${size}`
  let url = urls.get(key)
  if (!url) {
    url = URL.createObjectURL(new Blob([cursorSvg(cursorSet(set), state, size)], { type: 'image/svg+xml' }))
    urls.set(key, url)
  }
  return url
}

export function ghostCursor(set: CursorSetId, state: CursorState, size: CursorSize): GhostCursor {
  const url = cursorImageUrl(set, state, size)
  let cursor = ghosts.get(url)
  if (!cursor) {
    const image = new Image()
    image.src = url
    cursor = { image, hotspot: cursorHotspot(cursorSet(set), state, size) }
    ghosts.set(url, cursor)
  }
  return cursor
}
