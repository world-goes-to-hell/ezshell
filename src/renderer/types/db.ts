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
  /** The Docker container that publishes the port, when it was found that way */
  container?: string
}

/** A database account kept with a saved session (encrypted with the sessions) */
export interface SavedDbConnection {
  id: string
  /** Name the user gave the account ("MBRIS 조회용"), shown in the list */
  label?: string
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
  /** Where unqualified names go (PostgreSQL search_path; MySQL the database) */
  defaultSchema: string
  endpoint: DbEndpoint
  sessionName: string
  user: string
}

/**
 * Which table column a result column comes from, as the driver reports it (PostgreSQL: ids,
 * MySQL: names). The window only hands it back to ask for foreign keys.
 */
export interface DbColumnSource {
  tableId?: number
  columnId?: number
  schema?: string
  table?: string
  column?: string
}

export interface DbColumn {
  name: string
  type: string
  /** Absent for an expression (`amount * 2`, `count(*)`) */
  source?: DbColumnSource
}

/** A column a foreign key ties to */
export interface DbRelationTarget {
  schema: string
  table: string
  column: string
}

/** Foreign keys of one column: what it refers to, and the columns that refer to it */
export interface DbRelations {
  to: DbRelationTarget[]
  from: DbRelationTarget[]
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

/** A database the account may see; system ones are hidden in the tree by default */
export interface DbDatabase {
  name: string
  isSystem: boolean
}

/** A schema of a database (in MySQL the database itself) */
export interface DbSchema {
  name: string
  isSystem: boolean
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
