// One list of the backups the file window offers: the app's own (taken before each save, kept on this
// PC) and copies people left next to the file on the server. Used by the backup panel and the
// side-by-side comparison.
import type { RemoteFileBackup, RemoteServerBackup } from '../types'

export type BackupSource = 'app' | 'server'

export interface BackupEntry {
  source: BackupSource
  name: string
  time: number
  size: number
  /** Server files only: whether the time came from the name or the modification time */
  timeFrom?: 'name' | 'modified'
}

export const entryKey = (entry: Pick<BackupEntry, 'source' | 'name'>): string => `${entry.source}:${entry.name}`

/** Both kinds, newest first; an app backup comes first when two share a time. */
export function mergeBackups(app: RemoteFileBackup[] | null, server: RemoteServerBackup[] | null): BackupEntry[] {
  const fromApp: BackupEntry[] = (app ?? []).map(b => ({ source: 'app', name: b.name, time: b.createdAt, size: b.size }))
  const fromServer: BackupEntry[] = (server ?? []).map(b => ({ source: 'server', name: b.name, time: b.time, size: b.size, timeFrom: b.timeFrom }))
  return [...fromApp, ...fromServer].sort((a, b) => b.time - a.time || (a.source === b.source ? 0 : a.source === 'app' ? -1 : 1))
}

/** The key of the next older or newer backup, or null at the end of the list. */
export function neighborOf(entries: BackupEntry[], key: string, direction: 'older' | 'newer'): string | null {
  const index = entries.findIndex(e => entryKey(e) === key)
  if (index === -1) return null
  const next = entries[direction === 'older' ? index + 1 : index - 1]
  return next ? entryKey(next) : null
}

/** Text of one backup, read from the PC or the server through main. */
export async function readBackupEntry(docId: string, entry: BackupEntry): Promise<{ content: string } | { error: string }> {
  const api = window.electronAPI
  const result = entry.source === 'app'
    ? await api.remoteFileReadBackup?.(docId, entry.name)
    : await api.remoteFileReadServerBackup?.(docId, entry.name)
  if (!result) return { error: '앱을 다시 시작한 뒤에 사용할 수 있습니다.' }
  return result.success ? { content: result.content } : { error: result.error }
}
