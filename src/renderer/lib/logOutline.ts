// What the log view shows about its markers and problems, read from the editor state: the status
// line's numbers and the rows of the list panel.
import type { EditorState } from '@codemirror/state'
import type { JumpLevel } from './logLevels'
import { linesAfter, markerStart, markersOf } from './logMarkers'
import { countProblems, firstIndexFrom, problemOrdinal, problemsOf, type LevelCounts } from './logProblems'

export interface MarkerRow {
  id: number
  pos: number
  time: string
  label?: string
  /** Line number the marker sits above */
  line: number
  linesAfter: number
  /** Errors and warnings from the marker to the end of the log */
  after: LevelCounts
}

export interface ProblemRow {
  pos: number
  level: JumpLevel
  line: number
  /** "10:00:01" when the line carries a time */
  time: string | null
  text: string
}

export interface LogOutline {
  counts: LevelCounts
  /** Which problem of the chosen levels the cursor is at or below: 3 of "3/15" (0 above the first) */
  ordinal: number
  /** Problems of the chosen levels */
  total: number
  markers: MarkerRow[]
  /** The marker set last (the status line shows it) */
  latestMarker: MarkerRow | null
  /** The marker the cursor is at or below */
  currentMarkerId: number | null
  /** Start of the problem the cursor is at or below */
  currentProblemPos: number | null
  /** Newest first, at most `limit` of the chosen levels; empty unless rows were asked for */
  rows: ProblemRow[]
  /** Problems of the chosen levels (the rows may be fewer) */
  matching: number
}

export const OUTLINE_ROW_LIMIT = 200
const ROW_TEXT_LENGTH = 240

const LEADING_STAMP = /^\[?\d{4}[-/.]\d{2}[-/.]\d{2}[T ]\d{2}:\d{2}:\d{2}[.,]?\d*(?:Z|[+-]\d{2}:?\d{2})?\]?\s+/
const CLOCK = /(?:^|[^\d:])(\d{2}:\d{2}:\d{2})(?![\d:])/

/** The time in a line and the line without a date and time at its start */
export function splitStamp(line: string): { time: string | null; text: string } {
  const head = line.slice(0, 60)
  const clock = CLOCK.exec(head)
  const stamp = LEADING_STAMP.exec(head)
  return {
    time: clock ? clock[1] : null,
    text: (stamp ? line.slice(stamp[0].length) : line).trim().slice(0, ROW_TEXT_LENGTH)
  }
}

export function buildOutline(
  state: EditorState,
  options: { levels: ReadonlySet<JumpLevel>; withRows: boolean; limit?: number; afterMarkerId?: number | null }
): LogOutline {
  const { doc } = state
  const problems = problemsOf(state)
  const head = doc.lineAt(state.selection.main.head).from

  const stored = markersOf(state)
  const markers: MarkerRow[] = stored.map(marker => ({
    ...marker,
    line: doc.lineAt(Math.min(marker.pos, doc.length)).number,
    linesAfter: linesAfter(state, marker),
    after: countProblems(problems, marker.pos)
  }))
  const latestMarker = markers.length > 0 ? markers.reduce((a, b) => (b.id > a.id ? b : a)) : null
  const above = [...markers].reverse().find(marker => marker.pos <= head)

  // The position and the rows follow the chosen levels, as moving does
  const from = markerStart(state, options.afterMarkerId)
  const matching = problems.slice(firstIndexFrom(problems, from)).filter(problem => options.levels.has(problem.level))
  const ordinal = problemOrdinal(matching, head)
  const rows: ProblemRow[] = options.withRows
    ? matching.slice(-(options.limit ?? OUTLINE_ROW_LIMIT)).reverse().map(problem => {
      const line = doc.lineAt(problem.pos)
      return { pos: problem.pos, level: problem.level, line: line.number, ...splitStamp(line.text) }
    })
    : []

  return {
    counts: countProblems(problems, from),
    ordinal,
    total: matching.length,
    markers,
    latestMarker,
    currentMarkerId: above ? above.id : null,
    currentProblemPos: ordinal > 0 ? matching[ordinal - 1].pos : null,
    rows,
    matching: matching.length
  }
}

/** Whether two outlines show the same thing (the view skips a render then) */
export function sameOutline(a: LogOutline, b: LogOutline): boolean {
  return JSON.stringify(a) === JSON.stringify(b)
}
