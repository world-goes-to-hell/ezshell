import { describe, it, expect } from 'vitest'
import { EditorState } from '@codemirror/state'
import {
  logMarkerField, addMarker, removeMarker, markerAtEnd, markerAtLine, toggleMarkerAtLine,
  markersOf, linesAfter, markerSummary, neighbourMarker, MAX_MARKERS
} from './logMarkers'

const make = (doc: string) => EditorState.create({ doc, extensions: [logMarkerField] })
const append = (state: EditorState, text: string) => state.update({ changes: { from: state.doc.length, insert: text } }).state

describe('logMarkers', () => {
  it('a marker at the end stays above the lines added after it', () => {
    let state = make('a\nb\n')
    state = state.update({ effects: addMarker.of(markerAtEnd(state, '15:42:10')) }).state
    state = append(state, 'c\nd\n')
    const [marker] = markersOf(state)
    expect(marker).toMatchObject({ id: 1, time: '15:42:10' })
    expect(state.doc.lineAt(marker.pos).text).toBe('c')
    expect(linesAfter(state, marker)).toBe(2)
  })

  it('counts nothing after a marker at the very end', () => {
    let state = make('a\nb\n')
    state = state.update({ effects: addMarker.of(markerAtEnd(state, 't')) }).state
    expect(linesAfter(state, markersOf(state)[0])).toBe(0)
  })

  it('a marker on a line sits at its start and keeps it while text is added', () => {
    let state = make('one\ntwo\nthree\n')
    state = state.update({ effects: addMarker.of(markerAtLine(state, 2, 't')) }).state
    state = append(state, 'four\n')
    const [marker] = markersOf(state)
    expect(state.doc.lineAt(marker.pos).text).toBe('two')
    expect(linesAfter(state, marker)).toBe(3)
  })

  it('moves markers when old lines are trimmed and drops the ones that were trimmed away', () => {
    let state = make('1\n2\n3\n4\n')
    state = state.update({ effects: [addMarker.of(markerAtLine(state, 1, 'a')), addMarker.of(markerAtLine(state, 3, 'b'))] }).state
    state = state.update({ changes: { from: 0, to: 4 } }).state // "1\n2\n" trimmed
    expect(markersOf(state).map(m => state.doc.lineAt(m.pos).text)).toEqual(['3'])
    expect(state.field(logMarkerField).lost).toBe(1)
  })

  it('numbers markers without reusing numbers and keeps them in document order', () => {
    let state = make('1\n2\n3\n')
    state = state.update({ effects: addMarker.of(markerAtLine(state, 3, 't')) }).state
    state = state.update({ effects: addMarker.of(markerAtLine(state, 1, 't')) }).state
    expect(markersOf(state).map(m => m.id)).toEqual([2, 1])
    state = state.update({ effects: removeMarker.of(2) }).state
    state = state.update({ effects: addMarker.of(markerAtLine(state, 2, 't')) }).state
    expect(markersOf(state).map(m => m.id)).toEqual([3, 1])
  })

  it('does not put two markers at one place and toggles a line marker off', () => {
    let state = make('1\n2\n')
    state = state.update({ effects: toggleMarkerAtLine(state, 1, 't') }).state
    state = state.update({ effects: addMarker.of(markerAtLine(state, 1, 't')) }).state
    expect(markersOf(state)).toHaveLength(1)
    state = state.update({ effects: toggleMarkerAtLine(state, 1, 't') }).state
    expect(markersOf(state)).toHaveLength(0)
  })

  it(`keeps at most ${MAX_MARKERS} markers`, () => {
    let state = make(Array.from({ length: 20 }, (_, i) => `${i}`).join('\n'))
    for (let line = 1; line <= MAX_MARKERS + 3; line++) {
      state = state.update({ effects: addMarker.of(markerAtLine(state, line, 't')) }).state
    }
    expect(markersOf(state)).toHaveLength(MAX_MARKERS)
  })

  it('summarises the latest marker and finds neighbours around a position', () => {
    let state = make('1\n2\n3\n4\n5\n')
    expect(markerSummary(state)).toBeNull()
    state = state.update({ effects: [addMarker.of(markerAtLine(state, 2, 'a')), addMarker.of(markerAtLine(state, 4, 'b'))] }).state
    expect(markerSummary(state)).toEqual({ count: 2, latest: expect.objectContaining({ id: 2 }), linesAfter: 2 })
    const [first, second] = markersOf(state)
    expect(neighbourMarker(state, 0, 1)?.id).toBe(first.id)
    expect(neighbourMarker(state, first.pos, 1)?.id).toBe(second.id)
    expect(neighbourMarker(state, second.pos, 1)?.id).toBe(first.id) // wraps
    expect(neighbourMarker(state, second.pos, -1)?.id).toBe(first.id)
    expect(neighbourMarker(state, first.pos, -1)?.id).toBe(second.id) // wraps
  })
})
