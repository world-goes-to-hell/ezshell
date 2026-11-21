import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import { pageTabTitle } from '../lib/browserTabTitle'

interface BrowserBookmark {
  url: string
  title: string
}

interface BrowserBookmarkState {
  bookmarks: BrowserBookmark[]
  toggleBookmark: (page: BrowserBookmark) => void
  removeBookmark: (url: string) => void
}

export const useBrowserBookmarkStore = create<BrowserBookmarkState>()(
  persist(
    set => ({
      bookmarks: [],
      toggleBookmark: page => set(({ bookmarks }) => ({
        bookmarks: bookmarks.some(bookmark => bookmark.url === page.url)
          ? bookmarks.filter(bookmark => bookmark.url !== page.url)
          : [{ url: page.url, title: pageTabTitle(page) }, ...bookmarks]
      })),
      removeBookmark: url => set(({ bookmarks }) => ({
        bookmarks: bookmarks.filter(bookmark => bookmark.url !== url)
      }))
    }),
    { name: 'ezshell.browserBookmarks', partialize: ({ bookmarks }) => ({ bookmarks }) }
  )
)
