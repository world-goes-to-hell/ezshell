// 프로젝트 검색 (docs/plan/2026-11-26-project-search.md): Shift twice opens the file search, Ctrl+Shift+F the
// content search, both on the folder of the local tab in front.

/** Two Shift taps within this, from the first release to the second press, open the file search */
export const DOUBLE_SHIFT_MS = 400

type KeyLike = { type: string; key: string; repeat?: boolean; ctrlKey?: boolean; altKey?: boolean; metaKey?: boolean }

/**
 * Feeds key events in order; true on the release that completes Shift twice. Typing never does it: a capital
 * or a Korean double consonant presses a letter while Shift is down, and any other key starts over. A tap
 * held longer than DOUBLE_SHIFT_MS, a repeat, or Ctrl/Alt/Meta with it does not count.
 */
export function createDoubleShift(now: () => number = () => performance.now()) {
  let downAt = -1
  let clean = false
  let lastTapAt = -1
  return (event: KeyLike): boolean => {
    if (event.key !== 'Shift') {
      if (event.type === 'keydown') { clean = false; lastTapAt = -1 }
      return false
    }
    if (event.type === 'keydown') {
      if (event.repeat || event.ctrlKey || event.altKey || event.metaKey) { clean = false; lastTapAt = -1; return false }
      if (lastTapAt >= 0 && now() - lastTapAt > DOUBLE_SHIFT_MS) lastTapAt = -1
      downAt = now()
      clean = true
      return false
    }
    if (event.type !== 'keyup') return false
    const tap = clean && downAt >= 0 && now() - downAt <= DOUBLE_SHIFT_MS
    clean = false
    downAt = -1
    if (!tap) { lastTapAt = -1; return false }
    if (lastTapAt >= 0) { lastTapAt = -1; return true }
    lastTapAt = now()
    return false
  }
}

/** The text cut where `query` occurs, for marking it */
export function highlightParts(text: string, query: string, caseSensitive: boolean): { text: string; hit: boolean }[] {
  if (!query) return [{ text, hit: false }]
  const haystack = caseSensitive ? text : text.toLowerCase()
  const needle = caseSensitive ? query : query.toLowerCase()
  const parts: { text: string; hit: boolean }[] = []
  let from = 0
  for (let at = haystack.indexOf(needle); at >= 0; at = haystack.indexOf(needle, at + needle.length)) {
    if (at > from) parts.push({ text: text.slice(from, at), hit: false })
    parts.push({ text: text.slice(at, at + needle.length), hit: true })
    from = at + needle.length
  }
  if (from < text.length) parts.push({ text: text.slice(from), hit: false })
  return parts.length ? parts : [{ text, hit: false }]
}

export type ContentRow =
  | { kind: 'file'; path: string; count: number }
  | { kind: 'line'; path: string; line: number; text: string; index: number }

/** File heads and their lines in one list; `index` counts the lines only (what the arrows move through) */
export function contentRows(files: readonly { path: string; matches: readonly { line: number; text: string }[] }[]): ContentRow[] {
  const rows: ContentRow[] = []
  let index = 0
  for (const file of files) {
    rows.push({ kind: 'file', path: file.path, count: file.matches.length })
    for (const match of file.matches) rows.push({ kind: 'line', path: file.path, line: match.line, text: match.text, index: index++ })
  }
  return rows
}

export function splitPath(relative: string): { name: string; folder: string } {
  const at = relative.lastIndexOf('/')
  return at < 0 ? { name: relative, folder: '' } : { name: relative.slice(at + 1), folder: relative.slice(0, at) }
}
