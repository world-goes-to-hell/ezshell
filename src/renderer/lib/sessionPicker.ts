import Fuse from 'fuse.js'
import type { Session, Folder } from '../stores/sessionStore'

export interface SessionPickerItem {
  session: Session
  /** "상위 / 하위" folder names, empty for root sessions */
  folderPath: string
  /** A tab for this saved session is already open */
  isOpen: boolean
}

export interface SessionPickerFolder {
  folder: Folder
  folders: SessionPickerFolder[]
  items: SessionPickerItem[]
}

const FOLDER_PATH_SEPARATOR = ' / '
const SEARCH_THRESHOLD = 0.35

/** Folder names from root to `folderId`; guards against parent cycles in stored data. */
export function getFolderPath(folderId: string | undefined, folders: Folder[]): string {
  const names: string[] = []
  const visited = new Set<string>()
  let current = folderId ? folders.find(f => f.id === folderId) : undefined

  while (current && !visited.has(current.id)) {
    visited.add(current.id)
    names.unshift(current.name)
    const parentId = current.parentId
    current = parentId ? folders.find(f => f.id === parentId) : undefined
  }
  return names.join(FOLDER_PATH_SEPARATOR)
}

export function buildPickerItems(
  sessions: Session[],
  folders: Folder[],
  openSessionIds: ReadonlySet<string>
): SessionPickerItem[] {
  return sessions.map(session => ({
    session,
    folderPath: getFolderPath(session.folderId, folders),
    isOpen: openSessionIds.has(session.id)
  }))
}

/** Fuzzy match on name, host, username and folder path; blank query keeps the original order. */
export function filterPickerItems(items: SessionPickerItem[], query: string): SessionPickerItem[] {
  const trimmed = query.trim()
  if (!trimmed) return items

  const fuse = new Fuse(items, {
    keys: [
      { name: 'session.name', weight: 3 },
      { name: 'session.host', weight: 2 },
      { name: 'session.username', weight: 1 },
      { name: 'folderPath', weight: 1 }
    ],
    threshold: SEARCH_THRESHOLD,
    ignoreLocation: true
  })
  return fuse.search(trimmed).map(result => result.item)
}

/** Build visible folder branches and the session order used by the picker keyboard. */
export function buildPickerTree(items: SessionPickerItem[], folders: Folder[]) {
  const known = new Set(folders.map(folder => folder.id))
  const children = new Map<string | undefined, Folder[]>()
  const byFolder = new Map<string | undefined, SessionPickerItem[]>()
  for (const folder of folders) {
    const parent = folder.parentId && known.has(folder.parentId) ? folder.parentId : undefined
    const siblings = children.get(parent)
    if (siblings) siblings.push(folder)
    else children.set(parent, [folder])
  }
  for (const item of items) {
    const folderId = item.session.folderId
    const key = folderId && known.has(folderId) ? folderId : undefined
    const siblings = byFolder.get(key)
    if (siblings) siblings.push(item)
    else byFolder.set(key, [item])
  }

  const ordered: SessionPickerItem[] = []
  const visited = new Set<string>()
  const branch = (folder: Folder): SessionPickerFolder[] => {
    if (visited.has(folder.id)) return []
    visited.add(folder.id)
    const nested = (children.get(folder.id) ?? []).flatMap(branch)
    const sessions = byFolder.get(folder.id) ?? []
    ordered.push(...sessions)
    return nested.length || sessions.length ? [{ folder, folders: nested, items: sessions }] : []
  }
  const roots = (children.get(undefined) ?? []).flatMap(branch)
  // Broken parent cycles have no root. Show their sessions under one of their folders anyway.
  for (const folder of folders) if (!visited.has(folder.id)) roots.push(...branch(folder))
  const unfiled = byFolder.get(undefined) ?? []
  ordered.push(...unfiled)
  return { folders: roots, items: unfiled, ordered }
}

/** Next highlighted index for arrow-key navigation, wrapping at both ends. */
export function moveSelection(index: number, delta: number, length: number): number {
  if (length <= 0) return 0
  return (index + delta + length) % length
}
