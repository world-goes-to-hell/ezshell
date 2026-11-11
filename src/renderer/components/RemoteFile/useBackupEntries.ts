import { useCallback, useEffect, useState } from 'react'
import { mergeBackups, type BackupEntry } from '../../lib/backupCompare'
import type { RemoteFileBackup, RemoteServerBackup } from '../../types'

interface BackupEntries {
  entries: BackupEntry[] | null
  /** Why the app's own backups could not be listed (server files fail quietly to an empty list) */
  error: string | null
  refresh: () => Promise<void>
}

/**
 * The app's backups and the server's backup files of one file window, read again whenever `version`
 * changes (after every save) and only while `isActive` (panel or comparison open).
 */
export function useBackupEntries(docId: string, version: number, isActive: boolean): BackupEntries {
  const [entries, setEntries] = useState<BackupEntry[] | null>(null)
  const [error, setError] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    const api = window.electronAPI
    const [appResult, serverResult] = await Promise.all([
      api.remoteFileBackups?.(docId),
      api.remoteFileServerBackups?.(docId)
    ])
    let app: RemoteFileBackup[] | null = null
    if (appResult?.success) {
      app = appResult.backups
      setError(null)
    } else if (appResult) {
      setError(appResult.error)
    }
    const server: RemoteServerBackup[] | null = serverResult?.success ? serverResult.backups : null
    setEntries(mergeBackups(app, server))
  }, [docId])

  useEffect(() => {
    if (isActive) void refresh()
  }, [isActive, refresh, version])

  return { entries, error, refresh }
}
