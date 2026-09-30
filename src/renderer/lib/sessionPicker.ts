import Fuse from 'fuse.js'
import type { Session, Folder } from '../stores/sessionStore'

export interface SessionPickerItem {
  session: Session
  /** "상위 / 하위" folder names, empty for root sessions */
  folderPath: string
  /** A tab for this saved session is already open */
  isOpen: boolean
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

/** Next highlighted index for arrow-key navigation, wrapping at both ends. */
export function moveSelection(index: number, delta: number, length: number): number {
  if (length <= 0) return 0
  return (index + delta + length) % length
}
