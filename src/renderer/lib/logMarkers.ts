import { EditorState, MapMode, StateEffect, StateField } from '@codemirror/state'

/**
 * Markers ("기준점") in the live log view: places the user wants to read on from. A marker is a
 * position at the start of a line; the view draws it as a band above that line (not text, so copy,
 * search and level counts never see it). Positions follow every change, a marker at the end stays
 * above what is appended later, and one whose line is trimmed away is dropped and counted in `lost`.
 */
export const MAX_MARKERS = 10

export interface LogMarker {
  id: number
  /** Start of the line the marker sits above (or the end of the log) */
  pos: number
  /** Local time it was set, "15:42:10" */
  time: string
}

export interface LogMarkerState {
  markers: LogMarker[]
  nextId: number
  /** Markers removed because their line was trimmed */
  lost: number
}

export const addMarker = StateEffect.define<{ pos: number; time: string }>()
export const removeMarker = StateEffect.define<number>()

const EMPTY: LogMarkerState = { markers: [], nextId: 1, lost: 0 }

export const logMarkerField = StateField.define<LogMarkerState>({
  create: () => EMPTY,
  update(value, tr) {
    let next = value
    if (tr.docChanged && value.markers.length > 0) {
      const kept: LogMarker[] = []
      for (const marker of value.markers) {
        // TrackAfter: lost when the first character of its line is deleted; assoc -1 keeps a marker
        // at the end in front of text appended there
        const pos = tr.changes.mapPos(marker.pos, -1, MapMode.TrackAfter)
        if (pos !== null) kept.push({ ...marker, pos })
      }
      next = { ...next, markers: kept, lost: next.lost + (value.markers.length - kept.length) }
    }
    for (const effect of tr.effects) {
      if (effect.is(addMarker)) {
        const { pos, time } = effect.value
        const isTaken = next.markers.some(m => m.pos === pos)
        if (isTaken || next.markers.length >= MAX_MARKERS || pos < 0 || pos > tr.state.doc.length) continue
        const markers = [...next.markers, { id: next.nextId, pos, time }].sort((a, b) => a.pos - b.pos)
        next = { ...next, markers, nextId: next.nextId + 1 }
      } else if (effect.is(removeMarker)) {
        next = { ...next, markers: next.markers.filter(m => m.id !== effect.value) }
      }
    }
    return next
  }
})

export const markersOf = (state: EditorState): LogMarker[] => state.field(logMarkerField).markers

/** A marker at the end of the log: what is appended later comes below it */
export function markerAtEnd(state: EditorState, time: string): { pos: number; time: string } {
  return { pos: state.doc.length, time }
}

/** A marker above line `line` (1-based) */
export function markerAtLine(state: EditorState, line: number, time: string): { pos: number; time: string } {
  return { pos: state.doc.line(Math.min(Math.max(1, line), state.doc.lines)).from, time }
}

/** Effect that removes the marker above `line`, or adds one when there is none */
export function toggleMarkerAtLine(state: EditorState, line: number, time: string): StateEffect<unknown> {
  const target = markerAtLine(state, line, time)
  const existing = markersOf(state).find(m => m.pos === target.pos)
  return existing ? removeMarker.of(existing.id) : addMarker.of(target)
}

/** Lines from the marker's line to the end of the log (the empty line after a final newline not counted) */
export function linesAfter(state: EditorState, marker: LogMarker): number {
  const doc = state.doc
  const lastLine = doc.length > 0 && doc.sliceString(doc.length - 1) === '\n' ? doc.lines - 1 : doc.lines
  return Math.max(0, lastLine - doc.lineAt(Math.min(marker.pos, doc.length)).number + 1)
}

/** The status line: how many markers, and the lines after the one set last */
export function markerSummary(state: EditorState): { count: number; latest: LogMarker; linesAfter: number } | null {
  const markers = markersOf(state)
  if (markers.length === 0) return null
  const latest = markers.reduce((a, b) => (b.id > a.id ? b : a))
  return { count: markers.length, latest, linesAfter: linesAfter(state, latest) }
}

/** The next marker after `pos` (1) or before it (-1) in the document, going round the ends */
export function neighbourMarker(state: EditorState, pos: number, direction: 1 | -1): LogMarker | null {
  const markers = markersOf(state)
  if (markers.length === 0) return null
  if (direction === 1) return markers.find(m => m.pos > pos) ?? markers[0]
  return [...markers].reverse().find(m => m.pos < pos) ?? markers[markers.length - 1]
}
