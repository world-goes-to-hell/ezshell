import { useCallback, useEffect, useMemo } from 'react'
import Fuse from 'fuse.js'
import type { CommandHistoryEntry } from '../types'
import { useCommandHistoryStore } from '../stores/commandHistoryStore'

const EMPTY: CommandHistoryEntry[] = []

/** Command history of the connection a terminal tab belongs to. */
export function useCommandHistory(sessionId: string) {
  const historyKey = useCommandHistoryStore(state => state.keyBySession[sessionId] ?? null)
  const entries = useCommandHistoryStore(state => (historyKey ? state.entriesByKey[historyKey] : undefined)) ?? EMPTY

  useEffect(() => {
    useCommandHistoryStore.getState().resolveKey(sessionId)
  }, [sessionId])

  const remove = useCallback((command: string) => {
    if (historyKey) useCommandHistoryStore.getState().remove(historyKey, command)
  }, [historyKey])

  const clear = useCallback(() => {
    if (historyKey) useCommandHistoryStore.getState().clear(historyKey)
  }, [historyKey])

  return { isAvailable: historyKey !== null, entries, remove, clear }
}

/** Newest-first list when the query is empty, otherwise fuzzy matches best-first. */
export function useFilteredHistory(entries: CommandHistoryEntry[], query: string): CommandHistoryEntry[] {
  const fuse = useMemo(() => new Fuse(entries, { keys: ['command'], threshold: 0.4, ignoreLocation: true }), [entries])
  return useMemo(() => {
    const trimmed = query.trim()
    return trimmed ? fuse.search(trimmed).map(result => result.item) : entries
  }, [fuse, entries, query])
}

export function formatHistoryTime(timestamp: number): string {
  const date = new Date(timestamp)
  const pad = (n: number) => String(n).padStart(2, '0')
  const time = `${pad(date.getHours())}:${pad(date.getMinutes())}`
  const isToday = date.toDateString() === new Date().toDateString()
  return isToday ? time : `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${time}`
}
