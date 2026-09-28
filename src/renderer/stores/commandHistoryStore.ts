import { create } from 'zustand'
import type { CommandHistoryEntry, CommandHistoryResult } from '../types'
import { getHistoryKey } from '../lib/commandCapture'
import { toast } from './toastStore'

/**
 * Terminal command history, kept per connection in the main process (encrypted).
 * One store per window so a tab, its split panes, the history panel and the popup share one list.
 */
interface CommandHistoryState {
  /** Terminal sessionId → history key (null: no connection info, or the API is unavailable) */
  keyBySession: Record<string, string | null>
  entriesByKey: Record<string, CommandHistoryEntry[]>
  resolveKey: (sessionId: string) => Promise<string | null>
  record: (sessionId: string, command: string) => Promise<void>
  remove: (key: string, command: string) => Promise<void>
  clear: (key: string) => Promise<void>
}

// Safe API pattern: a running app may still have an older preload without these functions
function isHistoryApiAvailable(): boolean {
  const api = window.electronAPI
  return typeof api?.commandHistoryGet === 'function' &&
    typeof api?.commandHistoryAdd === 'function' &&
    typeof api?.onCommandHistoryChanged === 'function' &&
    typeof api?.sshGetSessionInfo === 'function'
}

const pendingKeys = new Map<string, Promise<string | null>>()
let stopSync: (() => void) | null = null

export const useCommandHistoryStore = create<CommandHistoryState>((set, get) => {
  const setEntries = (key: string, entries: CommandHistoryEntry[]) =>
    set(state => ({ entriesByKey: { ...state.entriesByKey, [key]: entries } }))

  const applyResult = (key: string, result: CommandHistoryResult, failureTitle: string) => {
    if (result.success && result.entries) {
      setEntries(key, result.entries)
    } else if (!result.success) {
      toast.error(failureTitle, result.error || '다시 시도해 주세요')
    }
  }

  const startSync = () => {
    if (stopSync) return
    // Changes made from any window (or another pane) arrive here, so every list stays current
    stopSync = window.electronAPI.onCommandHistoryChanged(({ key, entries }) => setEntries(key, entries))
  }

  const loadKey = async (sessionId: string): Promise<string | null> => {
    try {
      const key = getHistoryKey(await window.electronAPI.sshGetSessionInfo(sessionId))
      set(state => ({ keyBySession: { ...state.keyBySession, [sessionId]: key } }))
      if (key && !(key in get().entriesByKey)) {
        const result = await window.electronAPI.commandHistoryGet(key)
        setEntries(key, result.success && result.entries ? result.entries : [])
      }
      return key
    } catch (error) {
      console.error('Failed to load command history:', error)
      return null
    } finally {
      pendingKeys.delete(sessionId)
    }
  }

  return {
    keyBySession: {},
    entriesByKey: {},

    resolveKey: (sessionId) => {
      if (!isHistoryApiAvailable()) return Promise.resolve(null)
      startSync()
      const known = get().keyBySession[sessionId]
      if (known) return Promise.resolve(known)
      const pending = pendingKeys.get(sessionId)
      if (pending) return pending
      const request = loadKey(sessionId)
      pendingKeys.set(sessionId, request)
      return request
    },

    record: async (sessionId, command) => {
      const key = await get().resolveKey(sessionId)
      if (!key) return
      try {
        const result = await window.electronAPI.commandHistoryAdd(key, command)
        // Recording runs on every Enter; a locked app or rejected line is not worth a toast
        if (result.success && result.entries) setEntries(key, result.entries)
      } catch (error) {
        console.error('Failed to record command:', error)
      }
    },

    remove: async (key, command) => {
      try {
        applyResult(key, await window.electronAPI.commandHistoryRemove(key, command), '명령어 삭제 실패')
      } catch (error) {
        console.error('Failed to remove command:', error)
        toast.error('명령어 삭제 실패', '다시 시도해 주세요')
      }
    },

    clear: async (key) => {
      try {
        applyResult(key, await window.electronAPI.commandHistoryClear(key), '기록 삭제 실패')
      } catch (error) {
        console.error('Failed to clear command history:', error)
        toast.error('기록 삭제 실패', '다시 시도해 주세요')
      }
    }
  }
})
