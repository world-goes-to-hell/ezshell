// What the status bar's DB list offers for a tab: accounts saved with the session first, then the
// databases found on the server that have no saved account yet.
import type { DbEndpoint, DbEngine, DiscoveredDb, SavedDbConnection } from '../types/db'

export const DEFAULT_PORTS: Record<'mysql' | 'postgres', number> = { mysql: 3306, postgres: 5432 }

export const ENGINE_NAMES: Record<DbEngine, string> = {
  mysql: 'MySQL/MariaDB',
  postgres: 'PostgreSQL',
  oracle: 'Oracle',
  mssql: 'SQL Server'
}

export interface DbChoice {
  key: string
  endpoint: DbEndpoint
  /** "MySQL", "PostgreSQL" ... */
  label: string
  /** "reader · 127.0.0.1:3306" */
  detail: string
  isSupported: boolean
  /** A port alone may be something else: shown as a guess */
  isGuess: boolean
  saved: SavedDbConnection | null
}

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '::1'])
const hostKey = (host: string): string => (LOOPBACK.has(host.trim().toLowerCase()) ? 'loopback' : host.trim().toLowerCase())

/** The same database whatever the loopback spelling */
export function endpointKey(endpoint: DbEndpoint): string {
  return `${endpoint.engine}|${hostKey(endpoint.host)}|${endpoint.port}`
}

export function buildChoices(found: DiscoveredDb[], saved: SavedDbConnection[]): DbChoice[] {
  const foundByKey = new Map(found.map(db => [endpointKey(db), db]))
  const savedKeys = new Set(saved.map(s => endpointKey(s)))
  const fromSaved = saved.map((s): DbChoice => {
    const match = foundByKey.get(endpointKey(s))
    return {
      key: `saved:${s.id}`,
      endpoint: { engine: s.engine, host: s.host, port: s.port },
      label: match?.label ?? ENGINE_NAMES[s.engine],
      detail: `${s.user}${s.database ? `/${s.database}` : ''} · ${s.host}:${s.port}`,
      isSupported: s.engine === 'mysql' || s.engine === 'postgres',
      isGuess: false,
      saved: s
    }
  })
  const fromFound = found
    .filter(db => !savedKeys.has(endpointKey(db)))
    .map((db): DbChoice => ({
      key: `found:${endpointKey(db)}`,
      endpoint: { engine: db.engine, host: db.host, port: db.port },
      label: db.label,
      detail: `${db.host}:${db.port}${db.isLocalOnly ? ' · 서버 안에서만 열림' : ''}`,
      isSupported: db.isSupported,
      isGuess: !db.isConfirmed,
      saved: null
    }))
  return [...fromSaved, ...fromFound]
}

/** Adds or replaces (same id, or same database and user) without changing the given list. */
export function upsertSavedConnection(list: SavedDbConnection[], next: SavedDbConnection): SavedDbConnection[] {
  const sameAccount = (s: SavedDbConnection): boolean =>
    s.id === next.id || (endpointKey(s) === endpointKey(next) && s.user === next.user)
  const kept = list.filter(s => !sameAccount(s))
  return [...kept, next]
}

export function removeSavedConnection(list: SavedDbConnection[], id: string): SavedDbConnection[] {
  return list.filter(s => s.id !== id)
}

/** Korean reason the form cannot be sent, or null */
export function endpointProblem(endpoint: { host: string; port: string | number }, user: string): string | null {
  const host = endpoint.host.trim()
  const port = Number(endpoint.port)
  if (!host) return '호스트를 입력해 주세요.'
  if (/[\s/\\@]/.test(host)) return '호스트에 공백이나 / \\ @ 를 넣을 수 없습니다.'
  if (!Number.isInteger(port) || port < 1 || port > 65535) return '포트는 1~65535 사이의 숫자입니다.'
  if (!user.trim()) return '사용자 이름을 입력해 주세요.'
  return null
}
