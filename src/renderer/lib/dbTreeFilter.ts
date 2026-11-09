// Which databases and schemas the DB window's tree shows (like DataGrip's "보일 스키마" picker).
// Only the user's own choices are stored; anything not chosen follows the default: shown unless it is
// a system database or schema. Kept per account in this PC's localStorage (a convenience only).
import type { DbDatabase, DbSchema } from '../types/db'

export interface TreeFilter {
  databases: Record<string, boolean>
  /** Key: database + "\u0000" + schema */
  schemas: Record<string, boolean>
}

export const EMPTY_FILTER: TreeFilter = { databases: {}, schemas: {} }

const schemaKey = (database: string, schema: string): string => `${database}\u0000${schema}`

export function isDatabaseShown(filter: TreeFilter, database: DbDatabase): boolean {
  return filter.databases[database.name] ?? !database.isSystem
}

export function isSchemaShown(filter: TreeFilter, database: string, schema: DbSchema): boolean {
  return filter.schemas[schemaKey(database, schema.name)] ?? !schema.isSystem
}

export function withDatabase(filter: TreeFilter, database: string, isShown: boolean): TreeFilter {
  return { ...filter, databases: { ...filter.databases, [database]: isShown } }
}

export function withSchema(filter: TreeFilter, database: string, schema: string, isShown: boolean): TreeFilter {
  return { ...filter, schemas: { ...filter.schemas, [schemaKey(database, schema)]: isShown } }
}

/** Every database shown (true) or every one hidden (false) */
export function withAllDatabases(filter: TreeFilter, databases: DbDatabase[], isShown: boolean): TreeFilter {
  return { ...filter, databases: Object.fromEntries(databases.map(d => [d.name, isShown])) }
}

/** "6/12": schemas shown out of all schemas of a database */
export function shownCount(filter: TreeFilter, database: string, schemas: DbSchema[]): string {
  return `${schemas.filter(s => isSchemaShown(filter, database, s)).length}/${schemas.length}`
}

/** One account's storage key: the same database server and user share the choices */
export function filterStorageKey(info: { engine: string; endpoint: { host: string; port: number }; user: string }): string {
  return `dbTreeFilter:${info.engine}:${info.endpoint.host}:${info.endpoint.port}:${info.user}`
}

const isBooleanRecord = (value: unknown): value is Record<string, boolean> =>
  typeof value === 'object' && value !== null && !Array.isArray(value) && Object.values(value).every(v => typeof v === 'boolean')

/** What was stored, or the empty filter when nothing usable is there */
export function parseFilter(raw: string | null): TreeFilter {
  if (!raw) return EMPTY_FILTER
  try {
    const value: unknown = JSON.parse(raw)
    if (typeof value !== 'object' || value === null) return EMPTY_FILTER
    const { databases, schemas } = value as { databases?: unknown; schemas?: unknown }
    return {
      databases: isBooleanRecord(databases) ? databases : {},
      schemas: isBooleanRecord(schemas) ? schemas : {}
    }
  } catch {
    return EMPTY_FILTER
  }
}

export function loadFilter(key: string): TreeFilter {
  try {
    return parseFilter(localStorage.getItem(key))
  } catch {
    return EMPTY_FILTER
  }
}

export function saveFilter(key: string, filter: TreeFilter): void {
  try {
    localStorage.setItem(key, JSON.stringify(filter))
  } catch {
    // Only a convenience
  }
}
