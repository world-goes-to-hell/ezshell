// The address bar of the browser tab suggests pages already visited or bookmarked, as a web browser does:
// a list under the bar, and the best address that begins with the typed text completed inline.
import type { BrowserBookmarkEntry, BrowserSavedPage, BrowserVisit } from '../types'

export interface AddressSuggestion {
  url: string
  title: string
  /** The address as shown and completed: no scheme */
  display: string
}

const MAX_SUGGESTIONS = 6
const SCHEME = /^https?:\/\//i

/** The address without its scheme, and without the slash of a bare host (localhost:5173) */
export function addressDisplay(url: string): string {
  const shown = url.replace(SCHEME, '')
  return /^[^/?#]+\/$/.test(shown) ? shown.slice(0, -1) : shown
}

const withoutWww = (text: string) => text.replace(/^www\./i, '')
const typedKey = (query: string) => withoutWww(query.trim().replace(SCHEME, '')).toLowerCase()

function* bookmarkPages(entries: readonly BrowserBookmarkEntry[]): Generator<BrowserSavedPage> {
  for (const entry of entries) {
    if (entry.kind === 'folder') yield* bookmarkPages(entry.children)
    else yield entry
  }
}

/** 3: the address begins with it, 2: a part of the address does (after . / - and so on), 1: address or title contains it */
function score(page: BrowserSavedPage, display: string, key: string): number {
  const address = display.toLowerCase()
  if (address.startsWith(key) || withoutWww(address).startsWith(key)) return 3
  const first = address.indexOf(key)
  for (let at = first; at > 0; at = address.indexOf(key, at + 1)) {
    if (!/[\p{L}\p{N}]/u.test(address[at - 1])) return 2
  }
  return first >= 0 || page.title.toLowerCase().includes(key) ? 1 : 0
}

export function suggestAddresses(query: string, history: readonly BrowserVisit[], bookmarks: readonly BrowserBookmarkEntry[]): AddressSuggestion[] {
  const key = typedKey(query)
  if (!key || /\s/.test(key)) return []
  const pages = new Map<string, { page: BrowserSavedPage; visitedAt: number }>()
  for (const visit of history) if (!pages.has(visit.url)) pages.set(visit.url, { page: visit, visitedAt: visit.visitedAt })
  for (const page of bookmarkPages(bookmarks)) if (!pages.has(page.url)) pages.set(page.url, { page, visitedAt: 0 })
  return [...pages.values()]
    .map(({ page, visitedAt }) => {
      const display = addressDisplay(page.url)
      return { suggestion: { url: page.url, title: page.title, display }, rank: score(page, display, key), visitedAt }
    })
    .filter(item => item.rank > 0)
    .sort((a, b) => b.rank - a.rank || b.visitedAt - a.visitedAt)
    .slice(0, MAX_SUGGESTIONS)
    .map(item => item.suggestion)
}

/**
 * The typed text completed with the first suggestion that begins with it, keeping the typed characters as
 * they are; null when no address begins with it or nothing is left to add.
 */
export function inlineCompletion(typed: string, suggestions: readonly AddressSuggestion[]): { text: string; url: string } | null {
  const key = typedKey(typed)
  if (!key || /\s/.test(typed)) return null
  for (const { display, url } of suggestions) {
    for (const shown of [display, withoutWww(display)]) {
      if (shown.toLowerCase().startsWith(key) && shown.length > key.length) return { text: typed + shown.slice(key.length), url }
    }
  }
  return null
}
