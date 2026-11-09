import { useCallback, useEffect, useState } from 'react'
import { RiArrowDownSLine, RiArrowRightSLine, RiDatabaseLine, RiEyeLine, RiKey2Line, RiPlayLine, RiRefreshLine, RiTableLine } from 'react-icons/ri'
import type { DbTable, DbTableColumn } from '../../types/db'
import type { SerialQueue } from '../../lib/serialQueue'

interface SchemaTreeProps {
  dbId: string
  /** The window's request line: the tree never asks main while another request runs */
  queue: SerialQueue
  /** False while a query runs: main answers one request at a time */
  isIdle: boolean
  onPreview: (schema: string, table: string) => void
  onInsert: (text: string) => void
}

type Loaded<T> = { status: 'loading' } | { status: 'error'; message: string } | { status: 'ready'; items: T }

/** Schemas → tables → columns, each level read when opened. */
export function SchemaTree({ dbId, queue, isIdle, onPreview, onInsert }: SchemaTreeProps) {
  const [schemas, setSchemas] = useState<Loaded<string[]>>({ status: 'loading' })
  const [current, setCurrent] = useState('')
  const [tables, setTables] = useState<Record<string, Loaded<DbTable[]>>>({})
  const [columns, setColumns] = useState<Record<string, Loaded<DbTableColumn[]>>>({})

  const loadSchemas = useCallback(async () => {
    setSchemas({ status: 'loading' })
    setTables({})
    setColumns({})
    const result = await queue.run(async () => window.electronAPI.dbSchemas?.(dbId))
    if (!result?.success) {
      setSchemas({ status: 'error', message: result ? result.error : '앱을 다시 시작해 주세요.' })
      return
    }
    setSchemas({ status: 'ready', items: result.schemas })
    setCurrent(result.current)
  }, [dbId, queue])

  useEffect(() => { void loadSchemas() }, [loadSchemas])

  const toggleSchema = async (schema: string): Promise<void> => {
    if (tables[schema]) {
      setTables(({ [schema]: _closed, ...rest }) => rest)
      return
    }
    if (!isIdle) return
    setTables(state => ({ ...state, [schema]: { status: 'loading' } }))
    const result = await queue.run(async () => window.electronAPI.dbTables?.(dbId, schema))
    setTables(state => ({ ...state, [schema]: result?.success ? { status: 'ready', items: result.tables } : { status: 'error', message: result && !result.success ? result.error : '읽지 못했습니다.' } }))
  }

  const toggleTable = async (schema: string, table: string): Promise<void> => {
    const key = `${schema}\u0000${table}`
    if (columns[key]) {
      setColumns(({ [key]: _closed, ...rest }) => rest)
      return
    }
    if (!isIdle) return
    setColumns(state => ({ ...state, [key]: { status: 'loading' } }))
    const result = await queue.run(async () => window.electronAPI.dbColumns?.(dbId, schema, table))
    setColumns(state => ({ ...state, [key]: result?.success ? { status: 'ready', items: result.columns } : { status: 'error', message: result && !result.success ? result.error : '읽지 못했습니다.' } }))
  }

  return (
    <nav className="db-tree" aria-label="스키마">
      <div className="db-tree-header">
        <span>스키마</span>
        <button type="button" className="db-icon-button" onClick={() => void loadSchemas()} disabled={!isIdle} title="새로고침" aria-label="스키마 새로고침">
          <RiRefreshLine size={14} />
        </button>
      </div>
      <div className="db-tree-body">
        {schemas.status === 'loading' && <div className="db-tree-note">읽는 중…</div>}
        {schemas.status === 'error' && <div className="db-tree-note is-error">{schemas.message}</div>}
        {schemas.status === 'ready' && schemas.items.length === 0 && <div className="db-tree-note">볼 수 있는 스키마가 없습니다.</div>}
        {schemas.status === 'ready' && (
          <ul role="tree">
            {schemas.items.map(schema => {
              const opened = tables[schema]
              return (
                <li key={schema} role="treeitem" aria-expanded={Boolean(opened)}>
                  <button type="button" className={`db-tree-row${schema === current ? ' is-current' : ''}`} onClick={() => void toggleSchema(schema)} onDoubleClick={() => onInsert(schema)}>
                    {opened ? <RiArrowDownSLine size={14} /> : <RiArrowRightSLine size={14} />}
                    <RiDatabaseLine size={14} className="db-tree-icon" />
                    <span className="db-tree-name">{schema}</span>
                  </button>
                  {opened?.status === 'loading' && <div className="db-tree-note is-nested">읽는 중…</div>}
                  {opened?.status === 'error' && <div className="db-tree-note is-nested is-error">{opened.message}</div>}
                  {opened?.status === 'ready' && (
                    <ul role="group">
                      {opened.items.length === 0 && <li className="db-tree-note is-nested">테이블 없음</li>}
                      {opened.items.map(table => {
                        const key = `${schema}\u0000${table.name}`
                        const cols = columns[key]
                        return (
                          <li key={table.name} role="treeitem" aria-expanded={Boolean(cols)}>
                            <div className="db-tree-line">
                              <button type="button" className="db-tree-row is-table" onClick={() => void toggleTable(schema, table.name)} onDoubleClick={() => onInsert(table.name)}>
                                {cols ? <RiArrowDownSLine size={14} /> : <RiArrowRightSLine size={14} />}
                                {table.kind === 'view' ? <RiEyeLine size={14} className="db-tree-icon" /> : <RiTableLine size={14} className="db-tree-icon" />}
                                <span className="db-tree-name">{table.name}</span>
                              </button>
                              <button type="button" className="db-icon-button db-tree-preview" disabled={!isIdle} onClick={() => onPreview(schema, table.name)} title="처음 100행 보기" aria-label={`${table.name} 처음 100행 보기`}>
                                <RiPlayLine size={13} />
                              </button>
                            </div>
                            {cols?.status === 'loading' && <div className="db-tree-note is-deeper">읽는 중…</div>}
                            {cols?.status === 'error' && <div className="db-tree-note is-deeper is-error">{cols.message}</div>}
                            {cols?.status === 'ready' && (
                              <ul role="group">
                                {cols.items.map(column => (
                                  <li key={column.name} role="treeitem" className="db-tree-column" onDoubleClick={() => onInsert(column.name)} title={`${column.name} ${column.type}${column.isNullable ? '' : ' NOT NULL'}`}>
                                    {column.isKey ? <RiKey2Line size={12} className="db-tree-key" aria-label="기본 키" /> : <span className="db-tree-key" />}
                                    <span className="db-tree-name">{column.name}</span>
                                    <span className="db-tree-type">{column.type}</span>
                                  </li>
                                ))}
                              </ul>
                            )}
                          </li>
                        )
                      })}
                    </ul>
                  )}
                </li>
              )
            })}
          </ul>
        )}
      </div>
    </nav>
  )
}
