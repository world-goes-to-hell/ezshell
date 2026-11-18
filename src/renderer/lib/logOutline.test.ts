import { describe, it, expect } from 'vitest'
import { EditorState } from '@codemirror/state'
import { buildOutline, splitStamp } from './logOutline'
import { addMarker, logMarkerField, markerAtLine, renameMarker } from './logMarkers'
import { logProblemField } from './logProblems'
import type { JumpLevel } from './logLevels'

const BOTH = new Set<JumpLevel>(['error', 'warn'])
const LOG = [
  '2026-11-18 10:00:00 INFO start',
  '2026-11-18 10:00:01 ERROR db down',
  'java.sql.SQLException: refused',
  '\tat a.B.c(B.java:1)',
  '2026-11-18 10:00:02 WARN slow',
  '2026-11-18 10:00:03 INFO ok',
  '2026-11-18 10:00:04 ERROR again',
  ''
].join('\n')

const make = () => EditorState.create({ doc: LOG, extensions: [logMarkerField, logProblemField] })

describe('splitStamp', () => {
  it('takes the time and drops the date and time at the start', () => {
    expect(splitStamp('2026-11-18 10:00:01.123 ERROR db down')).toEqual({ time: '10:00:01', text: 'ERROR db down' })
    expect(splitStamp('[2026-11-18T10:00:01+09:00] WARN x')).toEqual({ time: '10:00:01', text: 'WARN x' })
    expect(splitStamp('Nov 18 10:00:01 host app: ERROR y')).toEqual({ time: '10:00:01', text: 'Nov 18 10:00:01 host app: ERROR y' })
    expect(splitStamp('java.lang.Error: no time')).toEqual({ time: null, text: 'java.lang.Error: no time' })
  })
})

describe('the outline of a log', () => {
  it('counts reports and tells where the cursor is among them', () => {
    let state = make()
    expect(buildOutline(state, { levels: BOTH, withRows: false })).toMatchObject({ counts: { error: 2, warn: 1 }, total: 3, ordinal: 0, rows: [], currentProblemPos: null })
    state = state.update({ selection: { anchor: state.doc.line(4).from } }).state
    const outline = buildOutline(state, { levels: BOTH, withRows: false })
    expect(outline.ordinal).toBe(1)
    expect(outline.currentProblemPos).toBe(state.doc.line(2).from)
  })

  it('lists the newest problems first, of the chosen levels, up to the limit', () => {
    const state = make()
    const all = buildOutline(state, { levels: BOTH, withRows: true })
    expect(all.rows.map(row => [row.line, row.level, row.time, row.text])).toEqual([
      [7, 'error', '10:00:04', 'ERROR again'],
      [5, 'warn', '10:00:02', 'WARN slow'],
      [2, 'error', '10:00:01', 'ERROR db down']
    ])
    const errors = buildOutline(state, { levels: new Set<JumpLevel>(['error']), withRows: true, limit: 1 })
    expect(errors.matching).toBe(2)
    expect(errors.rows.map(row => row.line)).toEqual([7])
  })

  it('tells what came after each marker', () => {
    let state = make()
    state = state.update({ effects: [addMarker.of(markerAtLine(state, 1, 'a')), addMarker.of(markerAtLine(state, 5, 'b'))] }).state
    state = state.update({ effects: renameMarker.of({ id: 2, label: '배포 후' }), selection: { anchor: state.doc.line(6).from } }).state
    const outline = buildOutline(state, { levels: BOTH, withRows: false })
    expect(outline.markers.map(m => [m.id, m.line, m.linesAfter, m.after, m.label])).toEqual([
      [1, 1, 7, { error: 2, warn: 1 }, undefined],
      [2, 5, 3, { error: 1, warn: 1 }, '배포 후']
    ])
    expect(outline.latestMarker?.id).toBe(2)
    expect(outline.currentMarkerId).toBe(2)
  })
})
