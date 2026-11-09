// Query completion for the DB window: keywords from the SQL dialect (no request), table names of the
// default schema (read once), and column names only of the tables the statement names, one table
// at a time and remembered while the window is open. Nothing is read for the whole database at once
// (MySQL 5.7 opens every table file for information_schema.COLUMNS over a schema), and nothing is
// read while a query runs.
import type { Extension } from '@codemirror/state'
import { Prec } from '@codemirror/state'
import { keymap } from '@codemirror/view'
import { acceptCompletion, autocompletion, type Completion, type CompletionContext, type CompletionResult } from '@codemirror/autocomplete'
import { MySQL, PostgreSQL, keywordCompletionSource, sql } from '@codemirror/lang-sql'
import { completionSpot, identifierText, referencedTables, resolveQualifier } from '../../lib/sqlCompletion'
import { statementAt } from '../../lib/sqlStatements'
import type { SerialQueue } from '../../lib/serialQueue'
import type { DbTable, DbTableColumn } from '../../types/db'

/** Columns are offered for at most this many tables of one statement */
const MAX_TABLES_FOR_COLUMNS = 4

interface MetadataOptions {
  dbId: string
  queue: SerialQueue
  /** False while a query runs: only what is already known is offered then */
  isIdle: () => boolean
}

export interface DbMetadata {
  schemas: () => Promise<{ schemas: string[]; current: string } | null>
  tables: (schema: string) => Promise<DbTable[] | null>
  columns: (schema: string, table: string) => Promise<DbTableColumn[] | null>
}

/**
 * Remembers what was read, and shares one request among callers asking at the same time.
 * A failed read is not remembered (the next keystroke may try again).
 */
export function createDbMetadata({ dbId, queue, isIdle }: MetadataOptions): DbMetadata {
  const known = new Map<string, unknown>()
  const pending = new Map<string, Promise<unknown>>()

  function read<T>(key: string, fetch: () => Promise<T | null>): Promise<T | null> {
    if (known.has(key)) return Promise.resolve(known.get(key) as T)
    const inFlight = pending.get(key)
    if (inFlight) return inFlight as Promise<T | null>
    if (!isIdle()) return Promise.resolve(null)
    const request = queue.run(fetch).then((value) => {
      if (value !== null) known.set(key, value)
      return value
    }, () => null).finally(() => pending.delete(key))
    pending.set(key, request)
    return request
  }

  return {
    schemas: () => read('schemas', async () => {
      const result = await window.electronAPI.dbSchemas?.(dbId)
      return result?.success ? { schemas: result.schemas, current: result.current } : null
    }),
    tables: (schema) => read(`tables\u0000${schema}`, async () => {
      const result = await window.electronAPI.dbTables?.(dbId, schema)
      return result?.success ? result.tables : null
    }),
    columns: (schema, table) => read(`columns\u0000${schema}\u0000${table}`, async () => {
      const result = await window.electronAPI.dbColumns?.(dbId, schema, table)
      return result?.success ? result.columns : null
    })
  }
}

interface SourceOptions {
  engine: 'mysql' | 'postgres'
  metadata: DbMetadata
  /** The schema unqualified names belong to (MySQL: the current database, after USE too) */
  defaultSchema: () => Promise<string>
}

const findTable = (tables: DbTable[] | null, name: string): DbTable | undefined =>
  tables?.find(t => t.name === name) ?? tables?.find(t => t.name.toLowerCase() === name.toLowerCase())

function columnOptions(columns: DbTableColumn[], engine: string, table: string, boost = 0): Completion[] {
  return columns.map(column => ({
    label: column.name,
    apply: identifierText(column.name, engine),
    type: 'property',
    detail: column.type,
    info: `${table}.${column.name}${column.isKey ? ' · 기본 키' : ''}${column.isNullable ? '' : ' · NOT NULL'}`,
    boost
  }))
}

function tableOptions(tables: DbTable[], engine: string, schema: string): Completion[] {
  return tables.map(table => ({
    label: table.name,
    apply: identifierText(table.name, engine),
    type: table.kind === 'view' ? 'interface' : 'class',
    detail: table.kind === 'view' ? `뷰 · ${schema}` : schema
  }))
}

/** Tables and columns; keywords come from the dialect's own source */
export function schemaSource({ engine, metadata, defaultSchema }: SourceOptions) {
  return async (context: CompletionContext): Promise<CompletionResult | null> => {
    const before = context.state.sliceDoc(Math.max(0, context.pos - 300), context.pos)
    const spot = completionSpot(before)
    if (spot.kind === 'plain' && !spot.prefix && !context.explicit) return null
    const from = context.pos - spot.prefix.length
    const doc = context.state.doc.toString()
    const statement = statementAt(doc, context.pos)?.text ?? ''
    const refs = referencedTables(statement)
    const fallbackSchema = await defaultSchema()

    if (spot.kind === 'qualified') {
      const ref = resolveQualifier(spot.qualifier, refs)
      const schema = ref?.schema ?? fallbackSchema
      const table = ref?.table ?? spot.qualifier
      const match = schema ? findTable(await metadata.tables(schema), table) : undefined
      if (schema && match) {
        const columns = await metadata.columns(schema, match.name)
        return columns ? { from, options: columnOptions(columns, engine, match.name), validFor: /^[\w$]*$/ } : null
      }
      // `schema.` → that schema's tables
      const schemas = await metadata.schemas()
      const named = schemas?.schemas.find(s => s.toLowerCase() === spot.qualifier.toLowerCase())
      if (!named) return null
      const tables = await metadata.tables(named)
      return tables ? { from, options: tableOptions(tables, engine, named), validFor: /^[\w$]*$/ } : null
    }

    const options: Completion[] = []
    if (fallbackSchema) {
      const tables = await metadata.tables(fallbackSchema)
      if (tables) options.push(...tableOptions(tables, engine, fallbackSchema))
    }
    for (const ref of refs.slice(0, MAX_TABLES_FOR_COLUMNS)) {
      const schema = ref.schema ?? fallbackSchema
      if (!schema) continue
      const table = findTable(await metadata.tables(schema), ref.table)
      if (!table) continue
      const columns = await metadata.columns(schema, table.name)
      // Columns of the named tables come first: they are what the statement is about
      if (columns) options.push(...columnOptions(columns, engine, table.name, 2))
    }
    return options.length ? { from, options, validFor: /^[\w$]*$/ } : null
  }
}

/** Editor extensions: SQL dialect, completion (typing or Ctrl+Space), Tab and Enter accept */
export function completionExtensions(options: SourceOptions): Extension[] {
  const dialect = options.engine === 'mysql' ? MySQL : PostgreSQL
  const keywords = keywordCompletionSource(dialect, true)
  // After `name.` only columns or tables make sense
  const keywordSource = (context: CompletionContext) =>
    /\.[\w$]*$/.test(context.state.sliceDoc(Math.max(0, context.pos - 100), context.pos)) ? null : keywords(context)
  return [
    sql({ dialect, upperCaseKeywords: true }),
    autocompletion({
      override: [schemaSource(options), keywordSource],
      activateOnTypingDelay: 150,
      icons: true
    }),
    Prec.highest(keymap.of([{ key: 'Tab', run: acceptCompletion }]))
  ]
}
