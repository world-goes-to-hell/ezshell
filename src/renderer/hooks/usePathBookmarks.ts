import { useCallback, useEffect, useState } from 'react'
import type { PathBookmarkSide } from '../types'
import { toast } from '../stores/toastStore'

interface PathBookmarksState {
  /** Saved-session id the bookmarks belong to; null for unsaved quick connects */
  bookmarkKey: string | null
  bookmarks: string[]
  isLoading: boolean
}

/**
 * Path bookmarks for one side (local/remote) of an SFTP connection.
 * Bookmarks are stored per saved sidebar session in the main process,
 * so the main window and popped-out SFTP windows stay in sync.
 */
export function usePathBookmarks(sessionId: string | undefined, side: PathBookmarkSide) {
  const [state, setState] = useState<PathBookmarksState>({ bookmarkKey: null, bookmarks: [], isLoading: true })

  useEffect(() => {
    const api = window.electronAPI
    // Safe API pattern: an app still running an older preload/main has no bookmark API yet
    const isSupported = typeof api?.sshGetSessionInfo === 'function' &&
      typeof api?.pathBookmarksGet === 'function' &&
      typeof api?.onPathBookmarksChanged === 'function'

    if (!sessionId || !isSupported) {
      setState({ bookmarkKey: null, bookmarks: [], isLoading: false })
      return
    }

    let cancelled = false
    const load = async () => {
      try {
        const info = await window.electronAPI.sshGetSessionInfo(sessionId)
        const key = info?.savedSessionId ?? null
        const entry = key ? await window.electronAPI.pathBookmarksGet(key) : null
        if (!cancelled) {
          setState({ bookmarkKey: key, bookmarks: entry ? entry[side] : [], isLoading: false })
        }
      } catch (error) {
        console.error('Failed to load path bookmarks:', error)
        if (!cancelled) setState({ bookmarkKey: null, bookmarks: [], isLoading: false })
      }
    }
    load()

    const unsubscribe = window.electronAPI.onPathBookmarksChanged(({ key, entry }) => {
      setState(prev => (prev.bookmarkKey === key ? { ...prev, bookmarks: entry[side] } : prev))
    })

    return () => {
      cancelled = true
      unsubscribe()
    }
  }, [sessionId, side])

  const save = useCallback(async (paths: string[]) => {
    if (!state.bookmarkKey) return
    try {
      const result = await window.electronAPI.pathBookmarksSet(state.bookmarkKey, side, paths)
      if (!result.success) {
        toast.error('즐겨찾기 저장 실패', result.error || '다시 시도해 주세요')
      }
      // The main process broadcasts the new list, which updates state via the subscription
    } catch (error) {
      console.error('Failed to save path bookmarks:', error)
      toast.error('즐겨찾기 저장 실패', '다시 시도해 주세요')
    }
  }, [state.bookmarkKey, side])

  const isBookmarked = useCallback((path: string) => state.bookmarks.includes(path), [state.bookmarks])

  const toggle = useCallback((path: string) => {
    const next = state.bookmarks.includes(path)
      ? state.bookmarks.filter(p => p !== path)
      : [...state.bookmarks, path]
    return save(next)
  }, [state.bookmarks, save])

  const remove = useCallback((path: string) => save(state.bookmarks.filter(p => p !== path)), [state.bookmarks, save])

  return {
    isAvailable: state.bookmarkKey !== null,
    isLoading: state.isLoading,
    bookmarks: state.bookmarks,
    isBookmarked,
    toggle,
    remove
  }
}
