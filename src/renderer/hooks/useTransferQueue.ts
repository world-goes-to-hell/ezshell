import { useCallback, useEffect, useRef, useState } from 'react'
import { useSftpStore } from '../stores/sftpStore'

const PENDING_STATUSES = new Set(['queued', 'active', 'paused'])

/**
 * Keeps the transfer queue in sync with the main process and decides when to show it.
 * - Hidden when the SFTP view opens, even if old (completed) transfers exist
 * - Opens automatically when a new transfer is queued
 * - The user can hide / show it at any time
 * Owning the IPC listeners here (instead of in the queue view) lets the view unmount while hidden.
 */
export function useTransferQueue(sessionId: string) {
  const store = useSftpStore()
  const transfers = store.transfers(sessionId)
  const [isVisible, setIsVisible] = useState(false)
  // Transfers that existed before / were already announced; new ids open the queue
  const seenIds = useRef<Set<string> | null>(null)

  useEffect(() => {
    const handleQueueUpdate = (data: any) => {
      if (data.sessionId === sessionId && data.queue) {
        useSftpStore.getState().setTransfers(sessionId, data.queue)
      }
    }
    const handleProgressUpdate = (data: any) => {
      if (data.sessionId === sessionId) {
        useSftpStore.getState().updateTransfer(sessionId, data.transferId, {
          progress: data.progress,
          speed: data.speed,
          status: 'active'
        })
      }
    }

    const offQueue = window.electronAPI.onSftpQueueUpdate(handleQueueUpdate)
    const offProgress = window.electronAPI.onSftpTransferProgress(handleProgressUpdate)
    return () => {
      // Older preloads return nothing; newer ones return an unsubscribe function
      if (typeof offQueue === 'function') offQueue()
      if (typeof offProgress === 'function') offProgress()
    }
  }, [sessionId])

  useEffect(() => {
    if (seenIds.current === null) {
      seenIds.current = new Set(transfers.map(t => t.id))
      return
    }
    const hasNewTransfer = transfers.some(t => !seenIds.current!.has(t.id))
    transfers.forEach(t => seenIds.current!.add(t.id))
    if (hasNewTransfer) setIsVisible(true)
  }, [transfers])

  const pendingCount = transfers.filter(t => PENDING_STATUSES.has(t.status)).length

  return {
    isVisible,
    pendingCount,
    show: useCallback(() => setIsVisible(true), []),
    hide: useCallback(() => setIsVisible(false), []),
    toggle: useCallback(() => setIsVisible(v => !v), [])
  }
}
