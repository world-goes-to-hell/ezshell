import { useEffect } from 'react'
import { useSessionLogStore } from '../stores/sessionLogStore'
import { toast } from '../stores/toastStore'

/** Keeps the "being logged" marks of the tabs in sync with the main process. Mount once. */
export function useSessionLogFeed(): void {
  useEffect(() => {
    const api = window.electronAPI
    if (typeof api?.onSessionLogChanged !== 'function' || typeof api?.sessionLogList !== 'function') return
    const { setLogging, clearLogging, mergeSnapshot } = useSessionLogStore.getState()
    let isMounted = true
    // Tabs that changed during this subscription; for those the event is newer than the list below
    const changedIds = new Set<string>()
    const off = api.onSessionLogChanged((change) => {
      changedIds.add(change.sessionId)
      if (change.isLogging && change.filePath) {
        setLogging(change.sessionId, change.filePath)
        return
      }
      clearLogging(change.sessionId)
      // Stopped by the app, not by the user: the file could not be written
      if (change.error) toast.error('로그 저장이 중단되었습니다', change.error)
    })
    // After a window reload the logs are still running in the main process
    api.sessionLogList()
      .then((result) => { if (isMounted && result.success) mergeSnapshot(result.items, changedIds) })
      .catch(() => { /* live changes still arrive */ })
    return () => {
      isMounted = false
      off()
    }
  }, [])
}
