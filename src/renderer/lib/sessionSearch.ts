// Finding saved sessions from the sidebar's search box. A search never hides anything: every
// session stays where it is in the tree, the ones that match are marked, and the folders holding
// them are shown open while the search lasts (the stored open/closed state is left alone).
import type { Session, Folder } from '../stores/sessionStore'
import { getFolderPath } from './sessionPicker'

const MAX_TERMS = 10
const MAX_TERM_LENGTH = 100

/** The words of a search: split at spaces, without case, each once */
export function sessionSearchTerms(query: string): string[] {
  const words = query.toLowerCase().split(/\s+/).map(word => word.slice(0, MAX_TERM_LENGTH)).filter(Boolean)
  return [...new Set(words)].slice(0, MAX_TERMS)
}

/** Every word must be in the session's name, host, account or folder names (AND) */
export function sessionMatches(session: Session, folderPath: string, terms: readonly string[]): boolean {
  if (terms.length === 0) return false
  const text = [session.name, session.host, session.username, folderPath].filter(Boolean).join('\n').toLowerCase()
  return terms.every(term => text.includes(term))
}

/** Sessions in the order the sidebar draws them: each folder's sub-folders, then its sessions; root sessions last */
export function sessionsInTreeOrder(sessions: readonly Session[], folders: readonly Folder[]): Session[] {
  const ordered: Session[] = []
  const visited = new Set<string>()
  const walk = (parentId: string | undefined) => {
    for (const folder of folders) {
      if (folder.parentId !== parentId || visited.has(folder.id)) continue
      visited.add(folder.id)
      walk(folder.id)
      ordered.push(...sessions.filter(session => session.folderId === folder.id))
    }
  }
  walk(undefined)
  ordered.push(...sessions.filter(session => !session.folderId))
  return ordered
}

export interface SessionSearchResult {
  /** Matching session ids in the order they appear in the tree */
  matchIds: string[]
  /** Folders that hold a match somewhere below them */
  openFolderIds: Set<string>
}

export function searchSessions(sessions: readonly Session[], folders: readonly Folder[], terms: readonly string[]): SessionSearchResult {
  const openFolderIds = new Set<string>()
  if (terms.length === 0) return { matchIds: [], openFolderIds }
  const byId = new Map(folders.map(folder => [folder.id, folder]))
  const matchIds: string[] = []
  for (const session of sessionsInTreeOrder(sessions, folders)) {
    if (!sessionMatches(session, getFolderPath(session.folderId, folders as Folder[]), terms)) continue
    matchIds.push(session.id)
    for (let folder = session.folderId ? byId.get(session.folderId) : undefined; folder && !openFolderIds.has(folder.id);
      folder = folder.parentId ? byId.get(folder.parentId) : undefined) {
      openFolderIds.add(folder.id)
    }
  }
  return { matchIds, openFolderIds }
}

/** Next current match for the arrow keys, wrapping at both ends */
export function stepMatch(index: number, delta: number, length: number): number {
  if (length <= 0) return 0
  return (index + delta + length) % length
}
