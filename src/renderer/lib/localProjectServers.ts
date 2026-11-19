import type { TerminalInfo } from '../stores/terminalStore'
import { pathKey } from './localWorkspaceTree'

// Saved SSH sessions grouped under a local project in the sidebar's local tree ("서버" row), kept
// across restarts. Only session ids are stored, never a host or an account, and nothing connects by
// itself when the app starts. Not part of the UI settings backup: the ids mean something only next to
// this PC's session file.

export const LOCAL_PROJECT_SERVERS_KEY = 'ezshell.localProjectServers'
export const LOCAL_PROJECT_SERVERS_EVENT = 'ezshell:local-project-servers-changed'
/** Window event that tells App a tab drag ended on the local tree (so the tab does not pop out) */
export const TAB_DROP_TAKEN_EVENT = 'ezshell:tab-drop-taken'

/** project key → saved session ids, in the order they were linked */
export type ProjectServers = Readonly<Record<string, readonly string[]>>

const MAX_PROJECTS = 200
const MAX_SESSIONS = 50
const MAX_KEY = 4096
const MAX_ID = 200

const isId = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= MAX_ID

export function parseProjectServers(raw: string | null): ProjectServers {
  let data: unknown
  try {
    data = JSON.parse(raw ?? '{}')
  } catch {
    return {}
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) return {}
  const result: Record<string, string[]> = {}
  for (const [key, ids] of Object.entries(data).slice(0, MAX_PROJECTS)) {
    if (!key || key.length > MAX_KEY || !Array.isArray(ids)) continue
    const usable = [...new Set(ids.filter(isId))].slice(0, MAX_SESSIONS)
    if (usable.length) result[key] = usable
  }
  return result
}

export function readProjectServers(): ProjectServers {
  try {
    return parseProjectServers(localStorage.getItem(LOCAL_PROJECT_SERVERS_KEY))
  } catch {
    return {}
  }
}

/** Saves and tells the other readers (the tree, the session menu); false when it could not be stored */
export function writeProjectServers(servers: ProjectServers): boolean {
  try {
    localStorage.setItem(LOCAL_PROJECT_SERVERS_KEY, JSON.stringify(servers))
  } catch {
    return false
  }
  window.dispatchEvent(new Event(LOCAL_PROJECT_SERVERS_EVENT))
  return true
}

export function linkServer(servers: ProjectServers, key: string, sessionId: string): ProjectServers {
  const current = servers[key] ?? []
  if (current.includes(sessionId)) return servers
  return { ...servers, [key]: [...current, sessionId].slice(0, MAX_SESSIONS) }
}

export function unlinkServer(servers: ProjectServers, key: string, sessionId: string): ProjectServers {
  const rest = (servers[key] ?? []).filter(id => id !== sessionId)
  const { [key]: _removed, ...others } = servers
  return rest.length ? { ...others, [key]: rest } : others
}

export function projectsOfSession(servers: ProjectServers, sessionId: string): string[] {
  return Object.keys(servers).filter(key => servers[key].includes(sessionId))
}

/** The repository's main checkout (or the one folder of a project that is not a Git checkout) */
export function projectKeyOf(project: { worktrees: ReadonlyArray<{ path: string; isMain: boolean }> }): string {
  const main = project.worktrees.find(tree => tree.isMain) ?? project.worktrees[0]
  return pathKey(main?.path ?? '')
}

/**
 * What a drop on a project card links: a sidebar session row (`session:<id>`) or a tab of a saved
 * session. Null for anything else (folders, text from elsewhere, a session that was deleted).
 */
export function sessionFromDrop(text: string, terminals: ReadonlyMap<string, TerminalInfo>, savedIds: ReadonlySet<string>):
  { sessionId: string } | { error: string } | null {
  if (text.startsWith('session:')) {
    const id = text.slice('session:'.length)
    return savedIds.has(id) ? { sessionId: id } : null
  }
  const tab = terminals.get(text)
  if (!tab) return null
  if (tab.local || tab.db) return { error: '로컬 터미널과 DB 탭은 묶을 수 없습니다. SSH 세션만 서버로 묶입니다.' }
  const id = tab.connectConfig?.savedSessionId
  if (!id || !savedIds.has(id)) return { error: '저장한 세션만 묶을 수 있습니다. 빠른 연결은 세션으로 저장한 뒤 묶어 주세요.' }
  return { sessionId: id }
}
