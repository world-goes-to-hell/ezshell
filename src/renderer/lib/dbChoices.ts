// What the status bar's DB list offers for a tab: accounts saved with the session first, then the
// databases found on the server that have no saved account yet.
import type { DbEndpoint, DbEngine, DiscoveredDb, SavedDbConnection } from '../types/db'

/** The engines the app can connect to (the others are only recognised on a server) */
export type ConnectableEngine = 'mysql' | 'postgres' | 'mssql'
export const CONNECTABLE_ENGINES: ConnectableEngine[] = ['mysql', 'postgres', 'mssql']
export const isConnectable = (engine: string | null | undefined): engine is ConnectableEngine => CONNECTABLE_ENGINES.includes(engine as ConnectableEngine)

export const DEFAULT_PORTS: Record<ConnectableEngine, number> = { mysql: 3306, postgres: 5432, mssql: 1433 }

export const ENGINE_NAMES: Record<DbEngine, string> = {
  mysql: 'MySQL/MariaDB',
  postgres: 'PostgreSQL',
  oracle: 'Oracle',
  mssql: 'SQL Server'
}

/** One database server in the list, with the accounts saved for it (several are allowed) */
export interface DbGroup {
  key: string
  endpoint: DbEndpoint
  /** The user's alias, or "MySQL", "PostgreSQL" ... */
  label: string
  /** Name the user gave this database server, if any */
  alias?: string
  /** "127.0.0.1:3306 · 서버 안에서만 열림"; with an alias the engine name moves here ("PostgreSQL · 127.0.0.1:5432") */
  detail: string
  isSupported: boolean
  /** A port alone may be something else: shown as a guess */
  isGuess: boolean
  accounts: SavedDbConnection[]
}

/** What the list shows for one saved account: its name, or user/database */
export function accountTitle(account: SavedDbConnection): string {
  const who = `${account.user}${account.database ? `/${account.database}` : ''}`
  return account.label ? `${account.label} (${who})` : who
}

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '::1'])
const hostKey = (host: string): string => (LOOPBACK.has(host.trim().toLowerCase()) ? 'loopback' : host.trim().toLowerCase())

/** The same database whatever the loopback spelling */
export function endpointKey(endpoint: DbEndpoint): string {
  return `${endpoint.engine}|${hostKey(endpoint.host)}|${endpoint.port}`
}

/** Aliases of database servers, kept with the session and keyed by endpointKey */
export type DbAliases = Record<string, string>

export const ALIAS_MAX_LENGTH = 40

/** One line, single spaces, at most ALIAS_MAX_LENGTH characters; '' means no alias */
export function normalizeAlias(raw: string): string {
  return Array.from(raw.replace(/\s+/g, ' ').trim()).slice(0, ALIAS_MAX_LENGTH).join('').trim()
}

/** Sets (or, for an empty alias, removes) one alias without changing the given map */
export function withAlias(aliases: DbAliases | undefined, key: string, raw: string): DbAliases {
  const { [key]: _previous, ...rest } = aliases ?? {}
  const alias = normalizeAlias(raw)
  return alias ? { ...rest, [key]: alias } : rest
}

/** Puts the alias in front; the found or engine name then goes to the detail line */
function applyAlias(group: DbGroup, aliases: DbAliases | undefined): DbGroup {
  const alias = aliases?.[group.key]
  if (!alias) return group
  return { ...group, alias, label: alias, detail: `${group.label} · ${group.detail}` }
}

/**
 * Database servers of the tab: those with saved accounts first (in the order they were saved), then
 * the ones found on the server without an account yet. A found server keeps its found label unless
 * the user gave it an alias.
 */
export function buildGroups(found: DiscoveredDb[], saved: SavedDbConnection[], aliases?: DbAliases): DbGroup[] {
  const foundByKey = new Map(found.map(db => [endpointKey(db), db]))
  const groups = new Map<string, DbGroup>()
  for (const account of saved) {
    const key = endpointKey(account)
    const existing = groups.get(key)
    if (existing) {
      groups.set(key, { ...existing, accounts: [...existing.accounts, account] })
      continue
    }
    const match = foundByKey.get(key)
    groups.set(key, {
      key,
      endpoint: { engine: account.engine, host: account.host, port: account.port },
      label: match?.label ?? ENGINE_NAMES[account.engine],
      detail: `${account.host}:${account.port}${match?.isLocalOnly ? ' · 서버 안에서만 열림' : ''}`,
      isSupported: isConnectable(account.engine),
      isGuess: false,
      accounts: [account]
    })
  }
  for (const db of found) {
    const key = endpointKey(db)
    if (groups.has(key)) continue
    groups.set(key, {
      key,
      endpoint: { engine: db.engine, host: db.host, port: db.port },
      label: db.label,
      detail: `${db.host}:${db.port}${db.isLocalOnly ? ' · 서버 안에서만 열림' : ''}`,
      isSupported: db.isSupported,
      isGuess: !db.isConfirmed,
      accounts: []
    })
  }
  return [...groups.values()].map(group => applyAlias(group, aliases))
}

/**
 * Adds or replaces without changing the given list. The same account is the same id, or the same
 * server, user and database (one user may be saved twice for two databases).
 */
export function upsertSavedConnection(list: SavedDbConnection[], next: SavedDbConnection): SavedDbConnection[] {
  const sameAccount = (s: SavedDbConnection): boolean =>
    s.id === next.id || (endpointKey(s) === endpointKey(next) && s.user === next.user && (s.database ?? '') === (next.database ?? ''))
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
