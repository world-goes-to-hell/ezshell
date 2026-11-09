// Types of the DB client (main: src/dbClient). Kept apart from index.ts, which is already long.

export type DbEngine = 'mysql' | 'postgres' | 'oracle' | 'mssql'

/** A database found on the tab's server (ports and process names only; nothing was connected to) */
export interface DiscoveredDb {
  engine: DbEngine
  label: string
  host: string
  port: number
  isLocalOnly: boolean
  isSupported: boolean
  isConfirmed: boolean
}

/** A database account kept with a saved session (encrypted with the sessions) */
export interface SavedDbConnection {
  id: string
  engine: DbEngine
  host: string
  port: number
  user: string
  password?: string
  database?: string
}

export interface DbEndpoint {
  engine: DbEngine
  host: string
  port: number
}

export interface DbCredentials {
  user: string
  password: string
  database: string
}

export interface DbServerInfo {
  engine: DbEngine
  product: string
  version: string
  /** Server-side guards the server did not take (old versions); the app's own limits still hold */
  missingGuards: string[]
}

export interface DbWindowInfo extends DbServerInfo {
  database: string
  endpoint: DbEndpoint
  sessionName: string
  user: string
}

export interface DbColumn {
  name: string
  type: string
}

export type DbCell = string | number | boolean | null

export interface DbQueryResult {
  columns: DbColumn[]
  rows: DbCell[][]
  truncatedBy: 'rows' | 'bytes' | null
  affectedRows: number | null
  elapsedMs: number
  database: string
}

export interface DbTable {
  name: string
  kind: 'table' | 'view'
}

export interface DbTableColumn {
  name: string
  type: string
  isNullable: boolean
  isKey: boolean
}

export type DbResult<T> = ({ success: true } & T) | { success: false; error: string }
