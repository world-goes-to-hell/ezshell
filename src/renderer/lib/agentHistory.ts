import type { AgentHistorySession, LocalAgent } from '../types'

export type AgentHistoryScope = 'project' | 'all'

/** Window event asking App to resume a listed session in a new local terminal tab (detail: ResumeAgentSessionRequest) */
export const RESUME_AGENT_SESSION_EVENT = 'ezshell:resume-agent-session'

export interface ResumeAgentSessionRequest {
  key: string
  agent: LocalAgent
  /** For the tab title */
  label: string
}

export const AGENT_LABELS: Record<LocalAgent, string> = { claude: 'Claude', codex: 'Codex' }

// Windows paths compare without case and with either slash; others as they are
const isWindowsPath = (value: string) => /^[a-zA-Z]:[\\/]/.test(value) || value.startsWith('\\\\')

function comparable(value: string): string {
  let text = value.replace(/\\/g, '/').replace(/\/+$/, '')
  if (isWindowsPath(value)) text = text.toLowerCase()
  return text || '/'
}

/** Whether `cwd` is one of `roots` or inside one */
export function isInside(cwd: string | null, roots: readonly string[]): boolean {
  if (!cwd) return false
  const path = comparable(cwd)
  return roots.some(root => {
    const base = comparable(root)
    return path === base || path.startsWith(base === '/' ? '/' : base + '/')
  })
}

function matchesQuery(session: AgentHistorySession, words: readonly string[]): boolean {
  if (!words.length) return true
  const text = [session.title, session.preview, session.cwd, session.branch, session.model, AGENT_LABELS[session.agent]]
    .filter(Boolean).join('\n').toLowerCase()
  return words.every(word => text.includes(word))
}

export interface AgentHistoryFilter {
  query: string
  /** Folders of the project in view; null shows every session */
  roots: readonly string[] | null
  showEmpty: boolean
}

/** Sessions to list, newest first as they came. Every word of the query must appear somewhere. */
export function filterSessions(sessions: readonly AgentHistorySession[], { query, roots, showEmpty }: AgentHistoryFilter): AgentHistorySession[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean)
  return sessions.filter(session =>
    (showEmpty || session.hasPrompt) &&
    (roots === null || isInside(session.cwd, roots)) &&
    matchesQuery(session, words))
}

/** A content search runs once the query has at least this many letters (a letter or two matches everything) */
export const CONTENT_SEARCH_MIN_LENGTH = 2

/**
 * The sessions to list when some matched by what was said in them (`hits`: key → excerpt, from the
 * main process): those matching by title, folder, branch or model, and those whose conversation
 * matched, in the list's order. Folder scope and the empty-session switch apply to both.
 */
export function withContentMatches(sessions: readonly AgentHistorySession[], filter: AgentHistoryFilter, hits: ReadonlyMap<string, string>): AgentHistorySession[] {
  const byFields = filterSessions(sessions, filter)
  if (hits.size === 0) return byFields
  const shown = new Set(byFields.map(session => session.key))
  return filterSessions(sessions, { ...filter, query: '' }).filter(session => shown.has(session.key) || hits.has(session.key))
}

export function relativeTime(time: number, now: number): string {
  const seconds = Math.max(0, Math.round((now - time) / 1000))
  if (seconds < 60) return '방금'
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}분 전`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}시간 전`
  const days = Math.floor(hours / 24)
  if (days < 7) return `${days}일 전`
  const date = new Date(time)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

/** Last part of a folder path, for the list */
export function folderName(cwd: string | null): string {
  if (!cwd) return ''
  const parts = cwd.split(/[\\/]+/).filter(Boolean)
  return parts[parts.length - 1] ?? cwd
}

const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * A command to paste into a terminal of this PC: go to the session's folder and resume it there
 * (Claude Code looks for the session under the folder it runs in). Null without a folder.
 */
export function resumeCommand(session: Pick<AgentHistorySession, 'agent' | 'id' | 'cwd'>, windows: boolean): string | null {
  if (!session.cwd || !SESSION_ID.test(session.id) || /[\0\r\n]/.test(session.cwd)) return null
  const resume = session.agent === 'claude' ? `claude --resume ${session.id}` : `codex resume ${session.id}`
  if (windows) return `Set-Location -LiteralPath '${session.cwd.replace(/'/g, "''")}'; ${resume}`
  return `cd '${session.cwd.replace(/'/g, `'\\''`)}' && ${resume}`
}
