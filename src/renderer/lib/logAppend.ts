// What adding a followed log's new text does to the log view: which old lines to drop to stay under
// the size limit, and the new error / warning counts. Pure, on CodeMirror's Text (no view needed).
import { Text, type ChangeSpec } from '@codemirror/state'
import { classifyLine } from './logLevels'

export interface LevelCounts {
  error: number
  warn: number
}

export const NO_COUNTS: LevelCounts = { error: 0, warn: 0 }

/** Errors and warnings among lines `from`..`to` (1-based, inclusive). */
export function countLevels(doc: Text, from = 1, to = doc.lines): LevelCounts {
  let error = 0
  let warn = 0
  for (let number = Math.max(1, from); number <= Math.min(to, doc.lines); number++) {
    const level = classifyLine(doc.line(number).text)
    if (level === 'error') error++
    else if (level === 'warn') warn++
  }
  return { error, warn }
}

const plus = (a: LevelCounts, b: LevelCounts): LevelCounts => ({ error: a.error + b.error, warn: a.warn + b.warn })
const minus = (a: LevelCounts, b: LevelCounts): LevelCounts => ({ error: a.error - b.error, warn: a.warn - b.warn })

export interface AppendPlan {
  changes: ChangeSpec[]
  counts: LevelCounts
  /** Errors in what was added (for the taskbar flash) */
  newErrors: number
  addedLines: number
  /** Older lines are dropped to stay under the limit */
  trimmed: boolean
}

export interface AppendLimits {
  /** Past this many characters the oldest whole lines go... */
  maxChars: number
  /** ...down to about this many */
  keepChars: number
}

/**
 * Add `text` at the end. Counts change only by the lines added and dropped; the last line before
 * adding is counted again, because the new text may finish it.
 */
export function planAppend(doc: Text, text: string, counts: LevelCounts, { maxChars, keepChars }: AppendLimits): AppendPlan {
  const total = doc.length + text.length
  const excess = total > maxChars ? total - keepChars : 0
  const cut = excess > 0 ? Math.min(doc.length, doc.lineAt(Math.min(excess, doc.length)).to + 1) : 0
  const removedLines = cut > 0 ? doc.lineAt(cut - 1).number : 0
  const lastLine = doc.line(doc.lines)
  const keepsLastLine = lastLine.number > removedLines

  let next = minus(counts, countLevels(doc, 1, removedLines))
  if (keepsLastLine) next = minus(next, countLevels(doc, lastLine.number, lastLine.number))

  const after = doc.replace(0, cut, Text.empty).append(Text.of(text.split('\n')))
  const firstChanged = keepsLastLine ? after.lineAt(lastLine.from - cut).number : 1
  const added = countLevels(after, firstChanged)
  return {
    changes: [{ from: 0, to: cut, insert: '' }, { from: doc.length, insert: text }],
    counts: plus(next, added),
    newErrors: added.error,
    addedLines: after.lines - (doc.lines - removedLines),
    trimmed: cut > 0
  }
}
