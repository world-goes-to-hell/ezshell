/**
 * Importing other programs' sessions (Xshell, PuTTY, MobaXterm, Tabby, OpenSSH config): what main
 * read (src/sessionImport) is shown next to the user's own list, and folders or sessions dragged
 * across are "staged" as new folders and sessions until 적용. No password comes in (phase 1); MCP
 * access is always off for what comes in.
 */
import type { Folder, Session } from '../stores/sessionStore'
import type { DropPosition } from './sessionOrder'

export interface ImportedFolder { id: string; name: string; parentId: string | null }
export interface ImportedJump { host: string; port: number; username: string }
export interface ImportedSession {
  id: string
  name: string
  folderId: string | null
  host: string
  port: number
  username: string
  authType: 'password' | 'privateKey'
  privateKeyPath: string
  /** A key the old program kept itself (Xshell's key store): the file has to be picked again */
  keyNote: string
  /** Whether the old program had a password saved (not imported); null when it cannot tell */
  hasSavedPassword: boolean | null
  jump: ImportedJump | null
}
export interface ImportResult {
  source: string
  label: string
  folders: ImportedFolder[]
  sessions: ImportedSession[]
  skipped: Record<string, number>
  truncated: boolean
}

/** Where a dropped session goes: before or after a session of mine (or a staged one) */
export interface Anchor { id: string; position: DropPosition }
export type StagedSession = Session & { importedId: string; anchor?: Anchor }
export interface Stage { folders: Folder[]; sessions: StagedSession[] }
export const EMPTY_STAGE: Stage = { folders: [], sessions: [] }

export type ImportNode = { type: 'folder' | 'session'; id: string }

type ExistingSession = Pick<Session, 'host' | 'port' | 'username'>

const keyOf = (host: string, port: number, username: string) => `${host.trim().toLowerCase()}:${port}:${username}`

/** Imported sessions that are already in the list (same host, port and user) */
export function duplicateIds(result: ImportResult, existing: ExistingSession[]): Set<string> {
  const have = new Set(existing.map(s => keyOf(s.host, s.port, s.username ?? '')))
  return new Set(result.sessions.filter(s => have.has(keyOf(s.host, s.port, s.username))).map(s => s.id))
}

/** Everything checked at first, except what is already there */
export function initialSelection(result: ImportResult, existing: ExistingSession[]): Set<string> {
  const dup = duplicateIds(result, existing)
  return new Set(result.sessions.filter(s => !dup.has(s.id)).map(s => s.id))
}

function childFolders(result: ImportResult, parentId: string | null): ImportedFolder[] {
  return result.folders.filter(f => f.parentId === parentId)
}

/** Ids of the sessions in a folder and all its sub-folders */
export function sessionsUnder(result: ImportResult, folderId: string, seen = new Set<string>()): string[] {
  if (seen.has(folderId)) return []
  seen.add(folderId)
  return [
    ...result.sessions.filter(s => s.folderId === folderId).map(s => s.id),
    ...childFolders(result, folderId).flatMap(f => sessionsUnder(result, f.id, seen))
  ]
}

export function folderCheckState(result: ImportResult, folderId: string, selected: ReadonlySet<string>): 'all' | 'some' | 'none' | 'empty' {
  const ids = sessionsUnder(result, folderId)
  if (ids.length === 0) return 'empty'
  const count = ids.filter(id => selected.has(id)).length
  return count === 0 ? 'none' : count === ids.length ? 'all' : 'some'
}

/** An imported session as one of the user's sessions (no password, MCP off) */
function toSession(imported: ImportedSession, folderId: string | null, id: string): StagedSession {
  const jump = imported.jump
  return {
    id,
    importedId: imported.id,
    name: imported.name,
    host: imported.host,
    port: imported.port,
    username: imported.username,
    authType: imported.authType,
    privateKeyPath: imported.privateKeyPath || undefined,
    folderId: folderId ?? undefined,
    icon: 'server',
    autoReconnect: true,
    mcpEnabled: false,
    ...(jump ? { useJumpHost: true, jumpHost: jump.host, jumpPort: jump.port, jumpUsername: jump.username, jumpAuthType: 'password' as const } : {})
  }
}

/**
 * Adds a dragged folder (its tree, with the checked sessions only) or a single session (even if
 * unchecked: it was dragged on purpose) under `targetFolderId` (null = top level). An imported
 * session already staged is not staged again. Returns a new stage.
 */
export function stageNode(stage: Stage, { result, node, targetFolderId, anchor, selected, newId }: {
  result: ImportResult
  node: ImportNode
  targetFolderId: string | null
  /** A session dropped on a session row goes before or after it (in its folder) */
  anchor?: Anchor
  selected: ReadonlySet<string>
  newId: () => string
}): Stage {
  const staged = new Set(stage.sessions.map(s => s.importedId))
  if (node.type === 'session') {
    const imported = result.sessions.find(s => s.id === node.id)
    if (!imported || staged.has(imported.id)) return stage
    const session = toSession(imported, targetFolderId, newId())
    return { ...stage, sessions: [...stage.sessions, anchor ? { ...session, anchor } : session] }
  }
  const folders: Folder[] = []
  const sessions: StagedSession[] = []
  const place = (folder: ImportedFolder, parentId: string | null, seen: Set<string>) => {
    if (seen.has(folder.id)) return
    seen.add(folder.id)
    const wanted = sessionsUnder(result, folder.id).filter(id => selected.has(id) && !staged.has(id))
    if (wanted.length === 0) return
    const id = newId()
    folders.push({ id, name: folder.name, parentId: parentId ?? undefined })
    for (const child of childFolders(result, folder.id)) place(child, id, seen)
    for (const imported of result.sessions.filter(s => s.folderId === folder.id && selected.has(s.id) && !staged.has(s.id))) {
      sessions.push(toSession(imported, id, newId()))
    }
  }
  const folder = result.folders.find(f => f.id === node.id)
  if (folder) place(folder, targetFolderId, new Set())
  if (folders.length === 0 && sessions.length === 0) return stage
  return { folders: [...stage.folders, ...folders], sessions: [...stage.sessions, ...sessions] }
}

/** 모두 적용: every checked session under a new top-level folder "가져옴 - <program>" */
export function stageAll({ result, selected, newId }: { result: ImportResult; selected: ReadonlySet<string>; newId: () => string }): Stage {
  if (![...selected].some(id => result.sessions.some(s => s.id === id))) return EMPTY_STAGE
  const rootId = newId()
  let stage: Stage = { folders: [{ id: rootId, name: `가져옴 - ${result.label}` }], sessions: [] }
  for (const folder of childFolders(result, null)) {
    stage = stageNode(stage, { result, node: { type: 'folder', id: folder.id }, targetFolderId: rootId, selected, newId })
  }
  for (const imported of result.sessions.filter(s => s.folderId === null && selected.has(s.id))) {
    stage = { ...stage, sessions: [...stage.sessions, toSession(imported, rootId, newId())] }
  }
  return stage
}

/**
 * My sessions with the staged ones put in place, in the order they will be saved (the sidebar shows
 * sessions in stored order). A staged session with an anchor goes before or after it; several
 * dropped after the same session keep the order they were dropped in. One without an anchor (or
 * whose anchor is gone) goes at the end.
 */
export function mergeOrder<T extends Pick<Session, 'id'>>(existing: T[], staged: StagedSession[]): Array<T | StagedSession> {
  const list: Array<T | StagedSession> = [...existing]
  const pending = [...staged]
  // Staged sessions can be anchored to staged ones: place in passes until nothing more fits
  for (let pass = 0; pending.length > 0 && pass <= staged.length; pass++) {
    for (let i = 0; i < pending.length;) {
      const session = pending[i]
      const anchor = session.anchor
      const at = anchor ? list.findIndex(s => s.id === anchor.id) : -1
      if (anchor && at < 0 && pending.some(p => p.id === anchor.id)) {
        i += 1
        continue
      }
      pending.splice(i, 1)
      if (!anchor || at < 0) {
        list.push(session)
        continue
      }
      if (anchor.position === 'before') {
        list.splice(at, 0, session)
        continue
      }
      // After the anchor and after those already placed after the same anchor
      let insertAt = at + 1
      while (insertAt < list.length) {
        const next = list[insertAt] as StagedSession
        if (next.anchor && next.anchor.id === anchor.id && next.anchor.position === 'after') insertAt += 1
        else break
      }
      list.splice(insertAt, 0, session)
    }
  }
  return [...list, ...pending]
}

/** A folder made in the "내 세션" panel; created on 적용 (empty or not) */
export function addStagedFolder(stage: Stage, { name, parentId, newId }: { name: string; parentId: string | null; newId: () => string }): Stage {
  const clean = name.replace(/\p{Cc}/gu, '').trim().slice(0, 100)
  if (!clean) return stage
  return { ...stage, folders: [...stage.folders, { id: newId(), name: clean, parentId: parentId ?? undefined }] }
}

/** Takes a staged folder (with everything staged inside it) or session back out */
export function removeStaged(stage: Stage, node: ImportNode): Stage {
  if (node.type === 'session') {
    const removed = stage.sessions.find(s => s.id === node.id)
    // Sessions placed next to the removed one take its place
    return {
      ...stage,
      sessions: stage.sessions
        .filter(s => s.id !== node.id)
        .map(s => (s.anchor?.id === node.id ? { ...s, anchor: removed?.anchor } : s))
    }
  }
  const gone = new Set<string>([node.id])
  let grew = true
  while (grew) {
    grew = false
    for (const f of stage.folders) {
      if (f.parentId && gone.has(f.parentId) && !gone.has(f.id)) {
        gone.add(f.id)
        grew = true
      }
    }
  }
  return {
    folders: stage.folders.filter(f => !gone.has(f.id)),
    sessions: stage.sessions.filter(s => !s.folderId || !gone.has(s.folderId))
  }
}
