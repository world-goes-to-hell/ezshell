import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { BrowserBookmarkEntry, BrowserBookmarkFolder } from '../types'

type BookmarkStore = typeof import('./browserBookmarkStore').useBrowserBookmarkStore
let bookmarks: BookmarkStore
const savedState = 'ezshell.browserBookmarks'
const oldPage = { title: '업무 링크', url: 'https://example.test/work' }
const otherPage = { title: 'ezShell에서 저장한 항목', url: 'https://example.test/manual' }

const folder = (id: string, title: string, children: BrowserBookmarkEntry[] = []): BrowserBookmarkFolder =>
  ({ kind: 'folder', id, title, children })

beforeEach(async () => {
  const stored = new Map([[savedState, JSON.stringify({ state: { bookmarks: [oldPage, otherPage], history: [] }, version: 0 })]])
  vi.stubGlobal('window', { localStorage: {
    getItem: (key: string) => stored.get(key) ?? null,
    setItem: (key: string, value: string) => stored.set(key, value),
    removeItem: (key: string) => stored.delete(key)
  } })
  vi.resetModules()
  bookmarks = (await import('./browserBookmarkStore')).useBrowserBookmarkStore
})
afterEach(() => vi.unstubAllGlobals())

describe('imported bookmark folders', () => {
  it('moves a matching old flat bookmark into its source folder and retains other local bookmarks', async () => {
    const tree = [folder('root:bar', '북마크바', [folder('work', '업무', [oldPage])])]
    expect(bookmarks.getState().importPages('profile-a', tree, []).bookmarks).toEqual({ added: 0, moved: 1, limited: false })
    const saved = [otherPage, folder('profile-a:root:bar', '북마크바', tree[0].children)]
    expect(bookmarks.getState().bookmarks).toEqual(saved)
    expect(bookmarks.getState().importPages('profile-a', tree, []).bookmarks).toEqual({ added: 0, moved: 0, limited: false })
    await bookmarks.persist.rehydrate()
    expect(bookmarks.getState().bookmarks).toEqual(saved)
  })

  it('keeps same-named folders and removes a bookmark only from its selected location', () => {
    const page = { title: '공통', url: 'https://example.test/shared' }
    const tree = [folder('root:bar', '북마크바', [folder('a', '자료', [page]), folder('b', '자료', [page, page])])]
    expect(bookmarks.getState().importPages('profile-a', tree, []).bookmarks.added).toBe(2)
    const [a, b] = (bookmarks.getState().bookmarks[2] as BrowserBookmarkFolder).children as BrowserBookmarkFolder[]
    expect(a.children[0]).not.toBe(b.children[0])
    bookmarks.getState().removeBookmark(a.children[0] as typeof page)
    const applied = bookmarks.getState().bookmarks[2] as BrowserBookmarkFolder
    expect(applied.children).toEqual([folder('a', '자료'), folder('b', '자료', [page])])
  })

  it('keeps an explicitly starred ezShell bookmark and imports another copy at its source path', () => {
    const page = { title: '공통', url: 'https://example.test/shared' }
    bookmarks.getState().toggleBookmark(page)
    expect(bookmarks.getState().importPages('profile-b', [folder('root:bar', '북마크바', [page])], []).bookmarks)
      .toEqual({ added: 1, moved: 0, limited: false })
    expect(bookmarks.getState().bookmarks[0]).toEqual({ ...page, local: true })
  })

  it('deletes exact selected folders and links in one update while keeping other locations and history', async () => {
    const page = { title: '공통', url: 'https://example.test/shared' }
    const visit = { ...page, visitedAt: 1 }
    bookmarks.getState().importPages('profile-b', [folder('bar', '북마크바', [folder('work', '업무', [page]), page])], [visit])
    const [first, kept, bar] = bookmarks.getState().bookmarks
    if (bar.kind !== 'folder') throw new Error('Expected a folder')
    bookmarks.getState().removeBookmarks(new Set([first, bar.children[0]]))
    expect(bookmarks.getState().bookmarks).toEqual([kept, { ...bar, children: [page] }])
    expect(bookmarks.getState().history).toEqual([visit])
    await bookmarks.persist.rehydrate()
    expect(bookmarks.getState().bookmarks).toEqual([kept, { ...bar, children: [page] }])
  })
})
