import { useEffect, useRef, useState } from 'react'
import {
  RiArrowDownSLine, RiArrowRightSLine, RiDatabase2Line, RiEyeLine, RiFolderLine, RiKey2Line, RiPlayLine, RiRefreshLine, RiTableLine
} from 'react-icons/ri'
import { SchemaCountMenu, TreeFilterMenu } from './TreeFilterMenu'
import { isDatabaseShown, isSchemaShown, type TreeFilter } from '../../lib/dbTreeFilter'
import type { SerialQueue } from '../../lib/serialQueue'
import type { DbDatabase, DbSchema, DbTable, DbTableColumn } from '../../types/db'

type Loaded<T> = { status: 'loading' } | { status: 'error'; message: string } | { status: 'ready'; items: T }

interface DatabaseTreeProps {
  dbId: string
  engine: 'mysql' | 'postgres'
  queue: SerialQueue
  /** False while a query runs: nothing new is read then */
  isIdle: boolean
  databases: Loaded<DbDatabase[]>
  /** The database queries run in */
  current: string
  /** PostgreSQL: the schema unqualified names go to in the current database */
  currentSchema: string
  onSetSchema: (database: string, schema: string) => void
  filter: TreeFilter
  onFilterChange: (filter: TreeFilter) => void
  onRefresh: () => void
  onSwitch: (database: string) => void
  onPreview: (database: string, schema: string, table: string) => void
  onInsert: (text: string) => void
}

const key = (...parts: string[]): string => parts.join('\u0000')
const failed = (result: { success: false; error: string } | undefined): Loaded<never> =>
  ({ status: 'error', message: result ? result.error : '읽지 못했습니다.' })

/**
 * Every database the account may see, like DataGrip: database → schema → table → column
 * (MySQL: database → table → column, a database being its schema). Each level is read when opened;
 * a PostgreSQL database other than the current one is read over a short connection in main.
 */
export function DatabaseTree(props: DatabaseTreeProps) {
  const { dbId, engine, queue, isIdle, databases, current, filter } = props
  const [schemas, setSchemas] = useState<Record<string, Loaded<DbSchema[]>>>({})
  const [tables, setTables] = useState<Record<string, Loaded<DbTable[]>>>({})
  const [columns, setColumns] = useState<Record<string, Loaded<DbTableColumn[]>>>({})
  const [open, setOpen] = useState<Set<string>>(() => new Set())
  // The current database starts open, once its list is in (and again after a refresh)
  const didOpenCurrent = useRef(false)
  useEffect(() => {
    if (databases.status !== 'ready' || !current || didOpenCurrent.current) return
    didOpenCurrent.current = true
    if (databases.items.some(d => d.name === current)) openDatabase(current)
    // openDatabase reads only state set up above; running again on its identity would reopen it
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [databases, current])

  const toggle = (id: string): boolean => {
    const isOpening = !open.has(id)
    setOpen(state => {
      const next = new Set(state)
      if (isOpening) next.add(id)
      else next.delete(id)
      return next
    })
    return isOpening
  }

  const loadSchemas = async (database: string): Promise<void> => {
    if (schemas[database]?.status === 'ready' || !isIdle) return
    setSchemas(state => ({ ...state, [database]: { status: 'loading' } }))
    const result = await queue.run(async () => window.electronAPI.dbSchemas?.(dbId, database))
    setSchemas(state => ({ ...state, [database]: result?.success ? { status: 'ready', items: result.schemas } : failed(result && !result.success ? result : undefined) }))
  }

  const loadTables = async (database: string, schema: string): Promise<void> => {
    const id = key(database, schema)
    if (tables[id]?.status === 'ready' || !isIdle) return
    setTables(state => ({ ...state, [id]: { status: 'loading' } }))
    const result = await queue.run(async () => window.electronAPI.dbTables?.(dbId, database, schema))
    setTables(state => ({ ...state, [id]: result?.success ? { status: 'ready', items: result.tables } : failed(result && !result.success ? result : undefined) }))
  }

  const loadColumns = async (database: string, schema: string, table: string): Promise<void> => {
    const id = key(database, schema, table)
    if (columns[id]?.status === 'ready' || !isIdle) return
    setColumns(state => ({ ...state, [id]: { status: 'loading' } }))
    const result = await queue.run(async () => window.electronAPI.dbColumns?.(dbId, database, schema, table))
    setColumns(state => ({ ...state, [id]: result?.success ? { status: 'ready', items: result.columns } : failed(result && !result.success ? result : undefined) }))
  }

  const openDatabase = (database: string): void => {
    if (!toggle(key('db', database))) return
    if (engine === 'mysql') void loadTables(database, database)
    else void loadSchemas(database)
  }

  const refresh = (): void => {
    setSchemas({})
    setTables({})
    setColumns({})
    setOpen(new Set())
    didOpenCurrent.current = false
    props.onRefresh()
  }

  const note = (state: Loaded<unknown> | undefined, depth: number) => {
    if (!state || state.status === 'ready') return null
    return (
      <div className={`db-tree-note${state.status === 'error' ? ' is-error' : ''}`} style={{ paddingLeft: 12 + depth * 14 }}>
        {state.status === 'loading' ? '읽는 중…' : state.message}
      </div>
    )
  }

  const renderTables = (database: string, schema: string, depth: number) => {
    const state = tables[key(database, schema)]
    if (state?.status !== 'ready') return note(state, depth)
    if (state.items.length === 0) return <div className="db-tree-note" style={{ paddingLeft: 12 + depth * 14 }}>테이블 없음</div>
    return (
      <ul role="group">
        {state.items.map(table => {
          const id = key(database, schema, table.name)
          const isOpen = open.has(key('t', id))
          const cols = columns[id]
          return (
            <li key={table.name} role="treeitem" aria-expanded={isOpen}>
              <div className="db-tree-line">
                <button type="button" className="db-tree-row is-table" style={{ paddingLeft: 8 + depth * 14 }}
                  onClick={() => { if (toggle(key('t', id))) void loadColumns(database, schema, table.name) }}
                  onDoubleClick={() => props.onInsert(table.name)}>
                  {isOpen ? <RiArrowDownSLine size={14} /> : <RiArrowRightSLine size={14} />}
                  {table.kind === 'view' ? <RiEyeLine size={14} className="db-tree-icon" /> : <RiTableLine size={14} className="db-tree-icon" />}
                  <span className="db-tree-name">{table.name}</span>
                </button>
                <button type="button" className="db-icon-button db-tree-preview" disabled={!isIdle}
                  onClick={() => props.onPreview(database, schema, table.name)} title="처음 100행 보기" aria-label={`${table.name} 처음 100행 보기`}>
                  <RiPlayLine size={13} />
                </button>
              </div>
              {isOpen && (cols?.status === 'ready' ? (
                <ul role="group">
                  {cols.items.map(column => (
                    <li key={column.name} role="treeitem" className="db-tree-column" style={{ paddingLeft: 22 + depth * 14 }}
                      onDoubleClick={() => props.onInsert(column.name)} title={`${column.name} ${column.type}${column.isNullable ? '' : ' NOT NULL'}`}>
                      {column.isKey ? <RiKey2Line size={12} className="db-tree-key" aria-label="기본 키" /> : <span className="db-tree-key" />}
                      <span className="db-tree-name">{column.name}</span>
                      <span className="db-tree-type">{column.type}</span>
                    </li>
                  ))}
                </ul>
              ) : note(cols, depth + 1))}
            </li>
          )
        })}
      </ul>
    )
  }

  const renderSchemas = (database: string) => {
    const state = schemas[database]
    if (state?.status !== 'ready') return note(state, 1)
    const shown = state.items.filter(s => isSchemaShown(filter, database, s))
    if (shown.length === 0) return <div className="db-tree-note" style={{ paddingLeft: 26 }}>보이는 스키마가 없습니다 (거르기에서 고르세요)</div>
    return (
      <ul role="group">
        {shown.map(schema => {
          const id = key('s', database, schema.name)
          const isOpen = open.has(id)
          const isDefault = database === current && schema.name === props.currentSchema
          return (
            <li key={schema.name} role="treeitem" aria-expanded={isOpen}>
              <div className="db-tree-line">
                <button type="button" className={`db-tree-row${schema.isSystem ? ' is-system' : ''}${isDefault ? ' is-current' : ''}`} style={{ paddingLeft: 22 }}
                  onClick={() => { if (toggle(id)) void loadTables(database, schema.name) }}
                  onDoubleClick={() => { if (!isDefault) props.onSetSchema(database, schema.name) }}
                  title={isDefault ? '기본 스키마: 테이블 이름만 써도 이 스키마에서 찾습니다' : '두 번 누르면 기본 스키마로 정합니다 (테이블 이름만 써도 됨)'}>
                  {isOpen ? <RiArrowDownSLine size={14} /> : <RiArrowRightSLine size={14} />}
                  <RiFolderLine size={14} className="db-tree-icon is-schema" />
                  <span className="db-tree-name">{schema.name}</span>
                </button>
                {isDefault && <span className="db-tree-tag">기본</span>}
              </div>
              {isOpen && renderTables(database, schema.name, 2)}
            </li>
          )
        })}
      </ul>
    )
  }

  const shownDatabases = databases.status === 'ready' ? databases.items.filter(d => isDatabaseShown(filter, d)) : []

  return (
    <nav className="db-tree" aria-label="데이터베이스">
      <div className="db-tree-header">
        <span>데이터베이스</span>
        <div className="db-tree-actions">
          <TreeFilterMenu engine={engine} databases={databases.status === 'ready' ? databases.items : []}
            schemas={schemas} filter={filter} onFilterChange={props.onFilterChange} onLoadSchemas={(db) => void loadSchemas(db)} />
          <button type="button" className="db-icon-button" onClick={refresh} disabled={!isIdle} title="새로고침" aria-label="데이터베이스 목록 새로고침">
            <RiRefreshLine size={14} />
          </button>
        </div>
      </div>
      <div className="db-tree-body">
        {databases.status !== 'ready' && note(databases, 0)}
        {databases.status === 'ready' && shownDatabases.length === 0 && <div className="db-tree-note">보이는 DB 가 없습니다 (거르기에서 고르세요)</div>}
        <ul role="tree">
          {shownDatabases.map(database => {
            const isOpen = open.has(key('db', database.name))
            const isCurrent = database.name === current
            const loadedSchemas = schemas[database.name]
            return (
              <li key={database.name} role="treeitem" aria-expanded={isOpen}>
                <div className="db-tree-line">
                  <button type="button" className={`db-tree-row is-database${isCurrent ? ' is-current' : ''}${database.isSystem ? ' is-system' : ''}`}
                    onClick={() => openDatabase(database.name)}
                    onDoubleClick={() => { if (!isCurrent) props.onSwitch(database.name) }}
                    title={isCurrent ? '쿼리를 실행하는 DB' : '두 번 누르면 이 DB 에서 쿼리를 실행합니다'}>
                    {isOpen ? <RiArrowDownSLine size={14} /> : <RiArrowRightSLine size={14} />}
                    <RiDatabase2Line size={14} className="db-tree-icon is-db" />
                    <span className="db-tree-name">{database.name}</span>
                  </button>
                  {engine === 'postgres' && (
                    <SchemaCountMenu database={database.name} loaded={loadedSchemas} filter={filter}
                      onFilterChange={props.onFilterChange} onOpen={() => void loadSchemas(database.name)} />
                  )}
                  {isCurrent && <span className="db-tree-tag">현재</span>}
                </div>
                {isOpen && (engine === 'mysql' ? renderTables(database.name, database.name, 1) : renderSchemas(database.name))}
              </li>
            )
          })}
        </ul>
      </div>
    </nav>
  )
}
