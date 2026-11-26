// 프로젝트 검색의 기록 (components/ProjectSearch): the searches whose result was opened, newest first, one list
// per mode. The empty search box lists them, and typing completes the newest that begins with the typed text.

export const MAX_SEARCH_HISTORY = 20
/** The longest search the search box takes (the content search's limit in main) */
const MAX_SEARCH_LENGTH = 200

/** The list with `text` first; unchanged for blank, multi-line or overlong text */
export function withSearch(list: readonly string[], text: string): string[] {
  if (!text.trim() || /[\r\n]/.test(text) || text.length > MAX_SEARCH_LENGTH) return list as string[]
  return [text, ...list.filter(entry => entry !== text)].slice(0, MAX_SEARCH_HISTORY)
}

export const withoutSearch = (list: readonly string[], text: string): string[] => list.filter(entry => entry !== text)

/** The typed text with the rest of the newest search that begins with it (any case), or null */
export function completeSearch(typed: string, history: readonly string[]): string | null {
  if (!typed) return null
  const lower = typed.toLowerCase()
  const match = history.find(entry => entry.length > typed.length && entry.toLowerCase().startsWith(lower))
  return match ? typed + match.slice(typed.length) : null
}
