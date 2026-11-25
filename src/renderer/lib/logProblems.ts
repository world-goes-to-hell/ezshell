// Errors and warnings of the log view as "problems": one per report, not one per line. A stack trace
// of 50 lines is one error. The list lives in the editor state and follows every change of the text
// (lines added at the end, old lines trimmed at the start) by reading only the lines that changed.
import { StateField, type ChangeDesc, type EditorState, type Text } from '@codemirror/state'
import { classifyProblemLine, classifyLine, isFrameSource, type JumpLevel, type LogLevel } from './logLevels'

export interface LogProblem {
  /** Start of the problem's first line */
  pos: number
  level: JumpLevel
}

export interface LevelCounts {
  error: number
  warn: number
}

export const NO_COUNTS: LevelCounts = { error: 0, warn: 0 }

const isProblemLevel = (level: LogLevel | null): level is JumpLevel => level === 'error' || level === 'warn'

/**
 * The problems that start in lines `fromLine`..`toLine` (1-based, inclusive). A line with a level
 * word always starts one; a crash line without one (exception name, "at ...") starts one only when
 * the line above is not an error or warning, otherwise it belongs to the problem above. The source
 * line a Python traceback prints under a frame keeps the report going (the exception name after it
 * is not a new error).
 */
export function scanProblems(doc: Text, fromLine = 1, toLine = doc.lines): LogProblem[] {
  const first = Math.max(1, fromLine)
  const last = Math.min(toLine, doc.lines)
  const found: LogProblem[] = []
  let previous = first > 1 ? doc.line(first - 1).text : ''
  // Whether the line above is part of a report: an error or warning line, or the source line of a Python frame
  let isInsideReport = first > 1 && (isProblemLevel(classifyLine(previous)) || (first > 2 && isFrameSource(doc.line(first - 2).text, previous)))
  for (let number = first; number <= last; number++) {
    const line = doc.line(number)
    const { level, start, inside } = classifyProblemLine(line.text, previous, isInsideReport)
    if (level && start) found.push({ pos: line.from, level })
    isInsideReport = inside
    previous = line.text
  }
  return found
}

/** A line can change what the two lines below it are (a frame line, its source line, the line after) */
const LINES_BELOW = 2

/**
 * The list after a change. Every changed line is read again, and the two lines after it too (whether a
 * line starts a problem depends on the lines above); the rest only moves.
 */
export function remapProblems(problems: readonly LogProblem[], oldDoc: Text, doc: Text, changes: ChangeDesc): LogProblem[] {
  const dropped: Array<[number, number]> = []
  const scanned: LogProblem[] = []
  changes.iterChangedRanges((fromA, toA, fromB, toB) => {
    const lastOld = Math.min(oldDoc.lines, oldDoc.lineAt(toA).number + LINES_BELOW)
    dropped.push([oldDoc.lineAt(fromA).from, oldDoc.line(lastOld).from])
    scanned.push(...scanProblems(doc, doc.lineAt(fromB).number, doc.lineAt(toB).number + LINES_BELOW))
  })
  const kept = problems
    .filter(problem => !dropped.some(([from, to]) => problem.pos >= from && problem.pos <= to))
    .map(problem => ({ ...problem, pos: changes.mapPos(problem.pos) }))
  const merged = [...kept, ...scanned].sort((a, b) => a.pos - b.pos)
  // Two changed ranges next to each other read the same line twice
  return merged.filter((problem, index) => index === 0 || merged[index - 1].pos !== problem.pos)
}

export const logProblemField = StateField.define<readonly LogProblem[]>({
  create: (state) => scanProblems(state.doc),
  update: (value, tr) => (tr.docChanged ? remapProblems(value, tr.startState.doc, tr.state.doc, tr.changes) : value)
})

export const problemsOf = (state: EditorState): readonly LogProblem[] => state.field(logProblemField)

/** Index of the first problem at or after `pos` (the list's length when there is none) */
export function firstIndexFrom(problems: readonly LogProblem[], pos: number): number {
  let low = 0
  let high = problems.length
  while (low < high) {
    const middle = (low + high) >> 1
    if (problems[middle].pos < pos) low = middle + 1
    else high = middle
  }
  return low
}

/** Errors and warnings among the problems at or after `pos` */
export function countProblems(problems: readonly LogProblem[], pos = 0): LevelCounts {
  let error = 0
  let warn = 0
  for (let index = firstIndexFrom(problems, pos); index < problems.length; index++) {
    if (problems[index].level === 'error') error++
    else warn++
  }
  return { error, warn }
}

/** How many problems start at or before `pos`: "3" of "3/15" for a cursor at `pos` (0 before the first) */
export function problemOrdinal(problems: readonly LogProblem[], pos: number): number {
  return firstIndexFrom(problems, pos + 1)
}

export type ProblemTarget = 1 | -1 | 'first' | 'last'
export type JumpOutcome = 'found' | 'wrapped' | 'none' | 'end'

/**
 * The problem to go to from `pos`: the next (1) or previous (-1) one of `levels`, or the first / last.
 * `wrap` goes round the ends ('wrapped'); without it the ends stop ('end'). 'none': no such problem,
 * or only the one at `pos`.
 */
export function findProblem(
  problems: readonly LogProblem[],
  pos: number,
  target: ProblemTarget,
  levels: ReadonlySet<JumpLevel>,
  wrap = true
): { outcome: JumpOutcome; problem: LogProblem | null } {
  const matching = problems.filter(problem => levels.has(problem.level))
  if (matching.length === 0) return { outcome: 'none', problem: null }
  if (target === 'first') return { outcome: 'found', problem: matching[0] }
  if (target === 'last') return { outcome: 'found', problem: matching[matching.length - 1] }
  const direct = target === 1
    ? matching.find(problem => problem.pos > pos)
    : [...matching].reverse().find(problem => problem.pos < pos)
  if (direct) return { outcome: 'found', problem: direct }
  if (!wrap) return { outcome: 'end', problem: null }
  const around = target === 1 ? matching[0] : matching[matching.length - 1]
  return around.pos === pos ? { outcome: 'none', problem: null } : { outcome: 'wrapped', problem: around }
}
