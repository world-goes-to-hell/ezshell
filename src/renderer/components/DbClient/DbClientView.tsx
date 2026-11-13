import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import {
  RiAddLine, RiCloseLine, RiDatabase2Line, RiErrorWarningLine, RiExternalLinkLine, RiFolderLine, RiLoader4Line, RiPlayFill, RiShieldCheckLine, RiStopFill
} from 'react-icons/ri'
import { DatabaseTree } from './DatabaseTree'
import { DbConsole, type DbConsoleHandle } from './DbConsole'
import { previewQuery, quoteIdentifier } from '../../lib/sqlStatements'
import { createSerialQueue } from '../../lib/serialQueue'
import { EMPTY_FILTER, filterStorageKey, loadFilter, saveFilter, type TreeFilter } from '../../lib/dbTreeFilter'
import {
  MAX_CONSOLES, addConsole, neighbourOf, parseConsoles, removeConsole, renameConsole, serializeConsoles, withSql, type ConsoleDraft
} from '../../lib/dbConsoles'
import { completionExtensions, createDbMetadata } from './dbCompletion'
import { copyToClipboard } from '../../lib/terminalClipboard'
import { toast } from '../../stores/toastStore'
import { TREE_DEFAULT_WIDTH, clampTreeWidth } from '../../lib/dbGrid'
import { isConnectable } from '../../lib/dbChoices'
import type { DbColumnSource, DbDatabase, DbRelations, DbWindowInfo } from '../../types/db'
import '../RemoteFile/RemoteFile.css'
import './DbClient.css'

type InfoState = { status: 'loading' } | { status: 'error'; message: string } | { status: 'ready'; info: DbWindowInfo }
type Loaded<T> = { status: 'loading' } | { status: 'error'; message: string } | { status: 'ready'; items: T }

const TREE_WIDTH_KEY = 'dbTreeWidth'
const schemaKey = (info: DbWindowInfo, database: string): string => `dbDefaultSchema:${filterStorageKey(info)}:${database}`
const consolesKey = (info: DbWindowInfo): string => `dbConsoles:${filterStorageKey(info)}`

function readStored(key: string): string | null {
  try {
    return localStorage.getItem(key)
  } catch {
    return null
  }
}

function writeStored(key: string, value: string): void {
  try {
    localStorage.setItem(key, value)
  } catch {
    // Only a convenience
  }
}

export interface DbViewTitle {
  title: string
  subtitle: string
}

interface DbClientViewProps {
  dbId: string
  /** Shown as a tab of the main window: offers "창으로 분리" */
  onDetach?: () => void
  /** Title of the window or tab (product and database, account and server) */
  onTitle?: (title: DbViewTitle) => void
  /** Rendered when the connection could not be read (the window shows its title bar around it) */
  renderMessage?: (content: React.ReactNode) => React.ReactNode
}

/**
 * A database account: database tree, query consoles (sub-tabs, each with its own editor and result)
 * and the toolbar. Used by the DB window and by DB tabs of the main window. Read-only.
 */
export function DbClientView({ dbId, onDetach, onTitle, renderMessage = (c) => c }: DbClientViewProps) {
  const [infoState, setInfoState] = useState<InfoState>({ status: 'loading' })
  const [database, setDatabase] = useState('')
  const [databases, setDatabases] = useState<Loaded<DbDatabase[]>>({ status: 'loading' })
  const [filter, setFilter] = useState<TreeFilter>(EMPTY_FILTER)
  const [isSwitching, setIsSwitching] = useState(false)
  const bodyRef = useRef<HTMLDivElement>(null)
  const [isResizingTree, setIsResizingTree] = useState(false)
  const [treeWidth, setTreeWidth] = useState(() => {
    try {
      return clampTreeWidth(Number(localStorage.getItem(TREE_WIDTH_KEY) ?? TREE_DEFAULT_WIDTH))
    } catch {
      return TREE_DEFAULT_WIDTH
    }
  })
  const [notice, setNotice] = useState<string | null>(null)
  // PostgreSQL: the schema unqualified names go to, and the schemas of the current database to pick from
  const [defaultSchema, setDefaultSchema] = useState('')
  const [currentSchemas, setCurrentSchemas] = useState<string[]>([])
  const [consoles, setConsoles] = useState<ConsoleDraft[]>([])
  const [activeConsole, setActiveConsole] = useState<string | null>(null)
  const [runningConsole, setRunningConsole] = useState<string | null>(null)
  const [renaming, setRenaming] = useState<string | null>(null)
  const consoleRefs = useRef(new Map<string, DbConsoleHandle>())
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  // Every request of this view, one after another (main refuses a second one while one runs)
  const queue = useMemo(() => createSerialQueue(), [])
  const isRunningRef = useRef(false)
  const databaseRef = useRef('')
  databaseRef.current = database
  const engine = infoState.status === 'ready' ? infoState.info.engine : null
  const metadata = useMemo(() => (isConnectable(engine)
    ? createDbMetadata({ dbId, engine, queue, database: () => databaseRef.current, isIdle: () => !isRunningRef.current })
    : null), [dbId, engine, queue])
  const isRunning = runningConsole !== null
  isRunningRef.current = isRunning
  const isBusy = isRunning || isSwitching

  const loadDatabases = useCallback(async () => {
    setDatabases({ status: 'loading' })
    const result = await queue.run(async () => window.electronAPI.dbDatabases?.(dbId))
    if (!result?.success) setDatabases({ status: 'error', message: result && !result.success ? result.error : '앱을 다시 시작해 주세요.' })
    else setDatabases({ status: 'ready', items: result.databases })
  }, [dbId, queue])

  useEffect(() => {
    void window.electronAPI.dbInfo?.(dbId).then(result => {
      if (!result) setInfoState({ status: 'error', message: '앱을 다시 시작한 뒤에 사용할 수 있습니다.' })
      else if (!result.success) setInfoState({ status: 'error', message: result.error })
      else {
        setInfoState({ status: 'ready', info: result })
        setDatabase(result.database)
        setDefaultSchema(result.defaultSchema)
        setFilter(loadFilter(filterStorageKey(result)))
        const stored = parseConsoles(readStored(consolesKey(result)))
        setConsoles(stored)
        setActiveConsole(stored[0].id)
        void loadDatabases()
      }
    })
  }, [dbId, loadDatabases])

  useEffect(() => {
    if (infoState.status !== 'ready') return
    const { info } = infoState
    onTitle?.({ title: `${info.product} · ${database || info.user}`, subtitle: `${info.user}@${info.endpoint.host}:${info.endpoint.port} · ${info.sessionName}` })
    // onTitle may be a new function every render of the parent
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [infoState, database])

  // Drafts are written half a second after the last change, and when the view goes away
  const pendingSave = useRef<(() => void) | null>(null)
  const persistConsoles = (next: ConsoleDraft[]): void => {
    if (infoState.status !== 'ready') return
    const key = consolesKey(infoState.info)
    if (saveTimer.current) clearTimeout(saveTimer.current)
    pendingSave.current = () => writeStored(key, serializeConsoles(next))
    saveTimer.current = setTimeout(() => {
      pendingSave.current?.()
      pendingSave.current = null
    }, 500)
  }
  useEffect(() => () => {
    if (saveTimer.current) clearTimeout(saveTimer.current)
    pendingSave.current?.()
  }, [])
  const updateConsoles = (change: (list: ConsoleDraft[]) => ConsoleDraft[]): void => {
    setConsoles(list => {
      const next = change(list)
      persistConsoles(next)
      return next
    })
  }

  // PostgreSQL: the schemas of the database queries run in, and the default schema chosen before for it
  useEffect(() => {
    if (infoState.status !== 'ready' || infoState.info.engine !== 'postgres' || !database) return
    let isCancelled = false
    const info = infoState.info
    void (async () => {
      const result = await queue.run(async () => window.electronAPI.dbSchemas?.(dbId, database))
      if (isCancelled || !result?.success) return
      const names = result.schemas.map(s => s.name)
      setCurrentSchemas(names)
      const remembered = readStored(schemaKey(info, database))
      if (remembered && names.includes(remembered) && remembered !== result.defaultSchema) await applySchema(remembered, { remember: false })
    })()
    return () => { isCancelled = true }
    // applySchema only uses refs and setters; it is redefined every render
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [infoState, database, dbId, queue])

  const changeFilter = (next: TreeFilter): void => {
    setFilter(next)
    if (infoState.status === 'ready') saveFilter(filterStorageKey(infoState.info), next)
  }

  const runQuery = async (sql: string) => {
    const result = await queue.run(async () => window.electronAPI.dbQuery?.(dbId, sql))
    if (result?.success) {
      if (result.database !== databaseRef.current) metadata?.reset()
      setDatabase(result.database)
    }
    return result
  }

  /** The database queries run in; completion forgets what it read for the old one */
  const switchDatabase = async (name: string): Promise<boolean> => {
    if (isBusy || name === databaseRef.current) return name === databaseRef.current
    setIsSwitching(true)
    const result = await queue.run(async () => window.electronAPI.dbSwitchDatabase?.(dbId, name))
    setIsSwitching(false)
    if (!result?.success) {
      setNotice(result && !result.success ? `${name} 으로 바꾸지 못했습니다: ${result.error}` : '앱을 다시 시작해 주세요.')
      return false
    }
    setNotice(null)
    metadata?.reset()
    setDatabase(result.database)
    setDefaultSchema(result.defaultSchema)
    setCurrentSchemas([])
    return true
  }

  /** PostgreSQL: put `schema` first in search_path, so its tables need no prefix; remembered per account and database */
  const applySchema = async (schema: string, { remember = true } = {}): Promise<void> => {
    if (infoState.status !== 'ready' || isRunningRef.current) return
    const info = infoState.info
    const result = await queue.run(async () => window.electronAPI.dbSetSchema?.(dbId, schema))
    if (!result?.success) {
      setNotice(result && !result.success ? `기본 스키마를 ${schema} 로 정하지 못했습니다: ${result.error}` : '앱을 다시 시작해 주세요.')
      return
    }
    setNotice(null)
    metadata?.reset()
    setDefaultSchema(result.defaultSchema)
    if (remember) writeStored(schemaKey(info, result.database), schema)
  }

  /** From the tree: a schema of another database switches to that database first */
  const setSchemaFromTree = async (db: string, schema: string): Promise<void> => {
    if (db !== databaseRef.current && !(await switchDatabase(db))) return
    await applySchema(schema)
  }

  const activeHandle = (): DbConsoleHandle | undefined => (activeConsole ? consoleRefs.current.get(activeConsole) : undefined)

  /** Adds the preview statement to the active console and runs it (in that table's database) */
  const preview = async (db: string, schema: string, table: string): Promise<void> => {
    if (infoState.status !== 'ready') return
    // PostgreSQL reads only the database it is connected to; MySQL names the database in the query
    // MySQL names the database in the query; the others run in one database at a time
    const needsSwitch = engine !== 'mysql' && db !== databaseRef.current
    if (needsSwitch && !(await switchDatabase(db))) return
    // Right after the switch the consoles are still marked as waiting for it (until the next render):
    // without saying so the query was typed in but not run
    activeHandle()?.appendAndRun(previewQuery(schema, table, infoState.info.engine), needsSwitch)
  }

  const cancel = (): void => { void window.electronAPI.dbCancel?.(dbId) }

  /** CREATE statements of a table (or a whole schema) to the clipboard */
  const copyDdl = async (db: string, schema: string, table?: string): Promise<void> => {
    if (!db || !schema) return
    const result = await queue.run(async () => window.electronAPI.dbDdl?.(dbId, db, schema, table))
    if (!result || !result.success) {
      toast.error('DDL 을 복사하지 못했습니다', result ? result.error : '앱을 다시 시작해 주세요.')
      return
    }
    if (!result.ddl) {
      toast.info('복사할 DDL 이 없습니다', table ?? `${schema} 에 테이블이 없습니다`)
      return
    }
    await copyToClipboard(result.ddl)
    if (result.isCut) toast.info('일부만 복사했습니다', `테이블이 많아 앞의 ${result.tableCount}개만 넣었습니다.`)
  }

  /** Foreign keys of a result's columns; null when they cannot be read (the grid then shows no marks) */
  const loadRelations = async (sources: DbColumnSource[]): Promise<DbRelations[] | null> => {
    const result = await queue.run(async () => window.electronAPI.dbRelations?.(dbId, sources))
    return result?.success ? result.relations : null
  }

  // ---- Width of the tree, changed with the handle beside it and remembered ----
  const saveTreeWidth = (width: number): void => {
    const next = clampTreeWidth(width, bodyRef.current?.clientWidth)
    setTreeWidth(next)
    try {
      localStorage.setItem(TREE_WIDTH_KEY, String(next))
    } catch {
      // Only a convenience
    }
  }
  const startTreeResize = (event: React.MouseEvent): void => {
    event.preventDefault()
    const startX = event.clientX
    const startWidth = treeWidth
    let latest = startWidth
    setIsResizingTree(true)
    const onMove = (move: MouseEvent): void => {
      latest = clampTreeWidth(startWidth + move.clientX - startX, bodyRef.current?.clientWidth)
      setTreeWidth(latest)
    }
    const onUp = (): void => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
      setIsResizingTree(false)
      saveTreeWidth(latest)
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }

  const extensions = useMemo(() => (metadata && isConnectable(engine) ? completionExtensions({ engine, metadata }) : []), [engine, metadata])

  const newConsole = (): void => {
    if (consoles.length >= MAX_CONSOLES) return
    const next = addConsole(consoles)
    updateConsoles(() => next)
    setActiveConsole(next[next.length - 1].id)
  }

  const closeConsole = (id: string): void => {
    if (id === runningConsole) return
    const neighbour = neighbourOf(consoles, id)
    const next = removeConsole(consoles, id)
    updateConsoles(() => next)
    consoleRefs.current.delete(id)
    if (activeConsole === id) setActiveConsole(neighbour && next.some(c => c.id === neighbour) ? neighbour : next[0].id)
  }

  const finishRename = (id: string, name: string): void => {
    updateConsoles(list => renameConsole(list, id, name))
    setRenaming(null)
  }

  const onConsoleKey = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (!(event.ctrlKey || event.metaKey) || event.altKey) return
    const key = event.key.toLowerCase()
    if (key === 't') {
      event.preventDefault()
      newConsole()
    } else if (key === 'w' && activeConsole && consoles.length > 1) {
      event.preventDefault()
      closeConsole(activeConsole)
    }
  }

  if (infoState.status !== 'ready' || !isConnectable(engine)) {
    return (
      <>
        {renderMessage(
          <div className="remote-file-message" role={infoState.status === 'error' ? 'alert' : 'status'}>
            {infoState.status === 'error'
              ? <><RiErrorWarningLine size={22} className="remote-file-message-icon" aria-hidden="true" /><span>{infoState.message}</span></>
              : <><RiLoader4Line className="spinning" size={22} aria-hidden="true" /><span>접속 정보를 읽는 중…</span></>}
          </div>
        )}
      </>
    )
  }

  const { info } = infoState
  const databaseNames = databases.status === 'ready' ? databases.items.map(d => d.name) : []

  return (
    <div className={`db-body${isResizingTree ? ' is-resizing' : ''}`} ref={bodyRef} onKeyDown={onConsoleKey}>
      <DatabaseTree
        dbId={dbId} engine={engine} queue={queue} isIdle={!isBusy}
        databases={databases} current={database} filter={filter} onFilterChange={changeFilter}
        currentSchema={defaultSchema}
        onSetSchema={(db, schema) => void setSchemaFromTree(db, schema)}
        onRefresh={() => void loadDatabases()}
        onSwitch={(name) => void switchDatabase(name)}
        onPreview={(db, schema, table) => void preview(db, schema, table)}
        onInsert={(name) => activeHandle()?.insertText(quoteIdentifier(name, info.engine))}
        onCopyDdl={(db, schema, table) => void copyDdl(db, schema, table)}
        width={treeWidth}
      />
      <div
        className={`db-tree-resizer${isResizingTree ? ' is-dragging' : ''}`}
        role="separator"
        aria-orientation="vertical"
        aria-label="데이터베이스 목록 너비"
        title="끌어서 너비 조절 · 두 번 누르면 처음 너비"
        onMouseDown={startTreeResize}
        onDoubleClick={() => saveTreeWidth(TREE_DEFAULT_WIDTH)}
      />
      <div className="db-main">
        <div className="db-toolbar">
          {isRunning
            ? <button type="button" className="db-run-button is-stop" onClick={cancel}><RiStopFill size={14} /> 취소</button>
            : <button type="button" className="db-run-button" onClick={() => activeHandle()?.runCurrent()} disabled={isSwitching}><RiPlayFill size={14} /> 실행 <kbd>Ctrl+Enter</kbd></button>}
          <label className="db-database-select" title="쿼리를 실행할 DB">
            <RiDatabase2Line size={13} aria-hidden="true" />
            <select value={database} disabled={isBusy || databaseNames.length === 0} onChange={(e) => void switchDatabase(e.target.value)} aria-label="쿼리를 실행할 DB">
              {!databaseNames.includes(database) && <option value={database}>{database || '(선택 안 됨)'}</option>}
              {databaseNames.map(name => <option key={name} value={name}>{name}</option>)}
            </select>
            {isSwitching && <RiLoader4Line className="spinning" size={13} aria-label="바꾸는 중" />}
          </label>
          {engine === 'postgres' && (
            <label className="db-database-select" title="기본 스키마: 테이블 이름만 써도 이 스키마에서 찾습니다">
              <RiFolderLine size={13} aria-hidden="true" />
              <select value={defaultSchema} disabled={isBusy || currentSchemas.length === 0} onChange={(e) => void applySchema(e.target.value)} aria-label="기본 스키마">
                {!currentSchemas.includes(defaultSchema) && <option value={defaultSchema}>{defaultSchema || '(없음)'}</option>}
                {currentSchemas.map(name => <option key={name} value={name}>{name}</option>)}
              </select>
            </label>
          )}
          <span className="db-readonly-badge" title="DB 서버가 쓰기를 거부하도록 접속했습니다. 쿼리는 30초, 결과는 1,000행까지입니다.">
            <RiShieldCheckLine size={13} aria-hidden="true" /> 읽기 전용
          </span>
          <span className="db-server-version">{info.version}</span>
          {info.missingGuards.length > 0 && (
            <span className="db-guard-warning" title={info.missingGuards.join('\n')}>
              <RiErrorWarningLine size={13} aria-hidden="true" /> 일부 서버 측 제한 없음
            </span>
          )}
          {onDetach && (
            <button type="button" className="db-icon-button db-detach" onClick={onDetach} disabled={isBusy} title="이 DB 탭을 새 창으로 옮깁니다 (접속은 그대로)">
              <RiExternalLinkLine size={14} /> 창으로 분리
            </button>
          )}
        </div>
        {notice && <div className="db-notice" role="alert"><RiErrorWarningLine size={13} aria-hidden="true" /> {notice}</div>}
        <div className="db-console-tabs" role="tablist" aria-label="쿼리 콘솔">
          {consoles.map(console_ => {
            const isActive = console_.id === activeConsole
            return (
              <div key={console_.id} role="tab" aria-selected={isActive} tabIndex={isActive ? 0 : -1}
                className={`db-console-tab${isActive ? ' is-active' : ''}`}
                onClick={() => setActiveConsole(console_.id)}
                onDoubleClick={() => setRenaming(console_.id)}
                onAuxClick={(e) => { if (e.button === 1 && consoles.length > 1) closeConsole(console_.id) }}
                title="두 번 누르면 이름 바꾸기 · 가운데 단추로 닫기">
                {console_.id === runningConsole && <RiLoader4Line className="spinning" size={12} aria-label="실행 중" />}
                {renaming === console_.id ? (
                  <input className="db-console-rename" defaultValue={console_.name} autoFocus maxLength={40}
                    onClick={(e) => e.stopPropagation()}
                    onBlur={(e) => finishRename(console_.id, e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') finishRename(console_.id, (e.target as HTMLInputElement).value)
                      if (e.key === 'Escape') setRenaming(null)
                    }} />
                ) : <span className="db-console-name">{console_.name}</span>}
                {consoles.length > 1 && (
                  <button type="button" className="db-console-close" disabled={console_.id === runningConsole}
                    onClick={(e) => { e.stopPropagation(); closeConsole(console_.id) }} aria-label={`${console_.name} 닫기`}>
                    <RiCloseLine size={12} />
                  </button>
                )}
              </div>
            )
          })}
          <button type="button" className="db-console-add" onClick={newConsole} disabled={consoles.length >= MAX_CONSOLES}
            title={consoles.length >= MAX_CONSOLES ? `콘솔은 ${MAX_CONSOLES}개까지` : '새 콘솔 (Ctrl+T)'} aria-label="새 콘솔">
            <RiAddLine size={14} />
          </button>
        </div>
        <div className="db-consoles">
          {consoles.map(console_ => (
            <DbConsole
              key={console_.id}
              ref={(handle) => {
                if (handle) consoleRefs.current.set(console_.id, handle)
                else consoleRefs.current.delete(console_.id)
              }}
              consoleId={console_.id}
              initialSql={console_.sql}
              isActive={console_.id === activeConsole}
              isBlocked={isSwitching || (runningConsole !== null && runningConsole !== console_.id)}
              engine={engine ?? ''}
              loadRelations={loadRelations}
              extensions={extensions}
              runQuery={runQuery}
              onRunningChange={(id, running) => setRunningConsole(running ? id : null)}
              onSqlChange={(id, sql) => updateConsoles(list => withSql(list, id, sql))}
            />
          ))}
        </div>
      </div>
    </div>
  )
}
