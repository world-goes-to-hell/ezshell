import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import { pageTabTitle } from '../lib/browserTabTitle'
import type { BrowserBookmarkEntry, BrowserBookmarkPage, BrowserSavedPage, BrowserVisit } from '../types'

const MAX_IMPORTED_CHARS = 1_000_000
const MAX_HISTORY = 1000

type ImportCount = { added: number; limited: boolean }

interface BrowserBookmarkState {
  bookmarks: BrowserBookmarkEntry[]
  history: BrowserVisit[]
  toggleBookmark: (page: BrowserSavedPage) => void
  removeBookmark: (page: BrowserBookmarkPage) => void
  clearHistory: () => void
  importPages: (profileId: string, bookmarks: BrowserBookmarkEntry[], history: BrowserVisit[]) => {
    bookmarks: ImportCount & { moved: number }
    history: ImportCount
  }
}

export function hasBookmark(entries: readonly BrowserBookmarkEntry[], url: string): boolean {
  return entries.some(entry => entry.kind === 'folder' ? hasBookmark(entry.children, url) : entry.url === url)
}

function withoutBookmarks(entries: BrowserBookmarkEntry[], remove: (entry: BrowserBookmarkPage) => boolean): BrowserBookmarkEntry[] {
  return entries.flatMap<BrowserBookmarkEntry>(entry => entry.kind === 'folder'
    ? [{ ...entry, children: withoutBookmarks(entry.children, remove) }]
    : remove(entry) ? [] : [entry])
}

const pageKey = (page: BrowserSavedPage) => JSON.stringify([page.url, page.title])

function mergeBookmarks(current: BrowserBookmarkEntry[], imported: BrowserBookmarkEntry[], profileId: string) {
  // Older imports left only flat URL/title pairs. When the same pair is committed to a folder,
  // move its old copy. New bookmarks starred inside ezShell are marked and stay at the root.
  const legacy = new Map<string, BrowserBookmarkPage>()
  for (const entry of current) if (entry.kind !== 'folder' && !entry.local) legacy.set(pageKey(entry), entry)
  const moved = new Set<BrowserBookmarkPage>()
  let size = JSON.stringify(current).length
  let added = 0
  let limited = false

  function append(entries: BrowserBookmarkEntry[], entry: BrowserBookmarkEntry, recovered = 0) {
    const delta = JSON.stringify(entry).length + 1 - recovered
    if (size + delta > MAX_IMPORTED_CHARS) { limited = true; return false }
    entries.push(entry)
    size += delta
    return true
  }

  function mergeLevel(before: BrowserBookmarkEntry[], nodes: BrowserBookmarkEntry[], root = false): BrowserBookmarkEntry[] {
    const entries = [...before]
    const folders = new Map<string, number>()
    const pages = new Set<string>()
    entries.forEach((entry, index) => {
      if (entry.kind === 'folder') folders.set(entry.id, index)
      else pages.add(pageKey(entry))
    })
    for (const node of nodes) {
      if (node.kind === 'folder') {
        const id = root ? `${profileId}:${node.id}` : node.id
        const index = folders.get(id) ?? entries.length
        const existing = entries[index]
        if (!existing && !append(entries, { ...node, id, children: [] })) continue
        const folder = entries[index]
        if (folder.kind !== 'folder') continue
        folders.set(id, index)
        entries[index] = { ...folder, children: mergeLevel(folder.children, node.children) }
      } else {
        const page = { url: node.url, title: pageTabTitle(node) }
        const key = pageKey(page)
        const old = root ? undefined : legacy.get(key)
        const move = old && !moved.has(old) ? old : null
        const recovered = move ? JSON.stringify(move).length + 1 : 0
        if (!pages.has(key)) {
          if (!append(entries, page, recovered)) continue
          pages.add(key)
          if (!move) added++
        } else {
          size -= recovered
        }
        if (move) moved.add(move)
      }
    }
    return entries
  }

  const entries = mergeLevel(current, imported, true).filter(entry => entry.kind === 'folder' || !moved.has(entry))
  return { entries, result: { added, moved: moved.size, limited } }
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
        bookmarks: hasBookmark(bookmarks, page.url)
          ? withoutBookmarks(bookmarks, entry => entry.url === page.url)
          : [{ url: page.url, title: pageTabTitle(page), local: true }, ...bookmarks]
      })),
      removeBookmark: page => set(({ bookmarks }) => ({
        bookmarks: withoutBookmarks(bookmarks, entry => entry === page)
      })),
      clearHistory: () => set({ history: [] }),
      importPages(profileId, bookmarks, history) {
        const current = get()
        const nextBookmarks = mergeBookmarks(current.bookmarks, bookmarks, profileId)
        const nextHistory = mergeHistory(current.history, history)
        set({ bookmarks: nextBookmarks.entries, history: nextHistory.entries })
        return { bookmarks: nextBookmarks.result, history: nextHistory.result }
      },
    }),
    { name: 'ezshell.browserBookmarks', partialize: ({ bookmarks, history }) => ({ bookmarks, history }) }
  )
)
