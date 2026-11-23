import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import { pageTabTitle } from '../lib/browserTabTitle'
import type { BrowserSavedPage, BrowserVisit } from '../types'

const MAX_IMPORTED_CHARS = 1_000_000
const MAX_HISTORY = 1000

type ImportCount = { added: number; limited: boolean }

interface BrowserBookmarkState {
  bookmarks: BrowserSavedPage[]
  history: BrowserVisit[]
  toggleBookmark: (page: BrowserSavedPage) => void
  removeBookmark: (url: string) => void
  clearHistory: () => void
  importPages: (bookmarks: BrowserSavedPage[], history: BrowserVisit[]) => { bookmarks: ImportCount; history: ImportCount }
}

function mergeBookmarks(current: BrowserSavedPage[], imported: BrowserSavedPage[]) {
  const urls = new Set(current.map(page => page.url))
  const entries = [...current]
  let size = JSON.stringify(current).length
  let limited = false
  for (const page of imported) {
    if (urls.has(page.url)) continue
    const entry = { ...page, title: pageTabTitle(page) }
    const length = JSON.stringify(entry).length + 1
    if (size + length > MAX_IMPORTED_CHARS) { limited = true; continue }
    size += length
    urls.add(page.url)
    entries.push(entry)
  }
  return { entries, result: { added: entries.length - current.length, limited } }
}

function mergeHistory(current: BrowserVisit[], imported: BrowserVisit[]) {
  const known = new Map(current.map(page => [page.url, page]))
  const merged = new Map(known)
  for (const page of imported) {
    if (page.visitedAt > (merged.get(page.url)?.visitedAt ?? 0)) merged.set(page.url, { ...page, title: pageTabTitle(page) })
  }
  const recent = [...merged.values()].sort((a, b) => b.visitedAt - a.visitedAt)
  const entries: BrowserVisit[] = []
  let size = 2
  for (const page of recent) {
    size += JSON.stringify(page).length + 1
    if (size > MAX_IMPORTED_CHARS || entries.length === MAX_HISTORY) break
    entries.push(page)
  }
  return { entries, result: { added: entries.filter(page => !known.has(page.url)).length, limited: entries.length < recent.length } }
}

export const useBrowserBookmarkStore = create<BrowserBookmarkState>()(
  persist(
    (set, get) => ({
      bookmarks: [],
      history: [],
      toggleBookmark: page => set(({ bookmarks }) => ({
        bookmarks: bookmarks.some(bookmark => bookmark.url === page.url)
          ? bookmarks.filter(bookmark => bookmark.url !== page.url)
          : [{ url: page.url, title: pageTabTitle(page) }, ...bookmarks]
      })),
      removeBookmark: url => set(({ bookmarks }) => ({
        bookmarks: bookmarks.filter(bookmark => bookmark.url !== url)
      })),
      clearHistory: () => set({ history: [] }),
      importPages(bookmarks, history) {
        const current = get()
        const nextBookmarks = mergeBookmarks(current.bookmarks, bookmarks)
        const nextHistory = mergeHistory(current.history, history)
        set({ bookmarks: nextBookmarks.entries, history: nextHistory.entries })
        return { bookmarks: nextBookmarks.result, history: nextHistory.result }
      },
    }),
    { name: 'ezshell.browserBookmarks', partialize: ({ bookmarks, history }) => ({ bookmarks, history }) }
  )
)
