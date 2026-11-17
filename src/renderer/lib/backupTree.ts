/**
 * The export list of 설정 > 백업 as a tree: folders (nested) with their sessions, so a whole folder is
 * picked with one checkbox instead of ticking every session of a long flat list.
 */

interface TreeFolder {
  id: string
  name: string
  parentId?: string
}

interface TreeSession {
  id: string
  folderId?: string
}

export type BackupRow<S extends TreeSession> =
  | { kind: 'folder'; id: string; name: string; depth: number; /** Every session under it, at any depth */ sessionIds: string[] }
  | { kind: 'session'; id: string; depth: number; session: S }

export type CheckState = 'all' | 'some' | 'none'

/**
 * Rows in display order: each folder, then its subfolders, then its sessions; top-level sessions last.
 * A collapsed folder keeps its row (and its `sessionIds`) but hides what is under it.
 * Sessions whose folder no longer exists, and folders in a parent cycle, show at the top level.
 */
export function buildBackupRows<S extends TreeSession>(
  folders: readonly TreeFolder[],
  sessions: readonly S[],
  collapsed: ReadonlySet<string> = new Set()
): BackupRow<S>[] {
  const folderIds = new Set(folders.map(folder => folder.id))
  const childrenOf = (parentId: string | undefined) =>
    folders.filter(folder => (folder.parentId && folderIds.has(folder.parentId) ? folder.parentId : undefined) === parentId)
  const sessionsOf = (folderId: string | undefined) =>
    sessions.filter(session => (session.folderId && folderIds.has(session.folderId) ? session.folderId : undefined) === folderId)

  const rows: BackupRow<S>[] = []
  const visited = new Set<string>()

  // Returns the ids of every session under the folder; pushes rows only while `visible`
  const walk = (folder: TreeFolder, depth: number, visible: boolean): string[] => {
    visited.add(folder.id)
    const row: BackupRow<S> = { kind: 'folder', id: folder.id, name: folder.name, depth, sessionIds: [] }
    if (visible) rows.push(row)
    const showChildren = visible && !collapsed.has(folder.id)
    const ids: string[] = []
    for (const child of childrenOf(folder.id)) {
      if (!visited.has(child.id)) ids.push(...walk(child, depth + 1, showChildren))
    }
    for (const session of sessionsOf(folder.id)) {
      ids.push(session.id)
      if (showChildren) rows.push({ kind: 'session', id: session.id, depth: depth + 1, session })
    }
    row.sessionIds = ids
    return ids
  }

  for (const folder of childrenOf(undefined)) walk(folder, 0, true)
  // Folders only reachable through a parent cycle would otherwise vanish with their sessions
  for (const folder of folders) {
    if (!visited.has(folder.id)) walk(folder, 0, true)
  }
  for (const session of sessionsOf(undefined)) rows.push({ kind: 'session', id: session.id, depth: 0, session })
  return rows
}

/** Whether all, some or none of the given sessions are selected (an empty folder counts as none) */
export function checkState(sessionIds: readonly string[], selected: ReadonlySet<string>): CheckState {
  const count = sessionIds.filter(id => selected.has(id)).length
  if (count === 0) return 'none'
  return count === sessionIds.length ? 'all' : 'some'
}

/** Clicking a folder's checkbox: select everything under it, or clear it when all were selected */
export function toggleMany(sessionIds: readonly string[], selected: ReadonlySet<string>): Set<string> {
  const next = new Set(selected)
  if (checkState(sessionIds, selected) === 'all') sessionIds.forEach(id => next.delete(id))
  else sessionIds.forEach(id => next.add(id))
  return next
}
