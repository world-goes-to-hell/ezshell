import { useEffect, useMemo, useRef, useState } from 'react'
import { Prec } from '@codemirror/state'
import { keymap } from '@codemirror/view'
import { RiDatabase2Line, RiErrorWarningLine, RiFileCopyLine, RiLoader4Line, RiPlayFill, RiShieldCheckLine, RiStopFill } from 'react-icons/ri'
import { PopoutTitleBar } from '../TitleBar/PopoutTitleBar'
import { CodeEditor, type CodeEditorHandle } from '../RemoteFile/CodeEditor'
import { SchemaTree } from './SchemaTree'
import { ResultGrid, resultAsTsv } from './ResultGrid'
import { usePopoutTheme } from '../../hooks/usePopoutTheme'
import { copyToClipboard } from '../../lib/terminalClipboard'
import { previewQuery, quoteIdentifier, statementAt } from '../../lib/sqlStatements'
import { createSerialQueue } from '../../lib/serialQueue'
import { completionExtensions, createDbMetadata } from './dbCompletion'
import type { DbQueryResult, DbWindowInfo } from '../../types/db'
import '../RemoteFile/RemoteFile.css'
import './DbClient.css'

type InfoState = { status: 'loading' } | { status: 'error'; message: string } | { status: 'ready'; info: DbWindowInfo }
type RunState =
  | { status: 'idle' }
  | { status: 'running'; sql: string; startedAt: number }
  | { status: 'done'; sql: string; result: DbQueryResult }
  | { status: 'error'; sql: string; message: string }

// fileName "query" has no extension on purpose: the editor then loads no language of its own and the
// dialect comes from completionExtensions (MySQL or PostgreSQL)
const INITIAL_SQL = '-- Ctrl+Enter: 커서가 있는 문장(또는 선택한 부분)을 실행합니다. Ctrl+Space: 자동완성. 조회만 할 수 있습니다.\n'

function summary(result: DbQueryResult): string {
  const seconds = (result.elapsedMs / 1000).toFixed(2)
  if (result.columns.length === 0) {
    return result.affectedRows !== null ? `완료 · ${result.affectedRows}행 · ${seconds}초` : `완료 · ${seconds}초`
  }
  const cut = result.truncatedBy === 'rows' ? ' · 처음 1,000행만 받았습니다' : result.truncatedBy === 'bytes' ? ' · 50MB 를 넘어 일부만 받았습니다' : ''
  return `${result.rows.length.toLocaleString()}행 · ${seconds}초${cut}`
}

/** A database in its own window (`?dbMode=true&dbId=...`): schema tree, SQL editor and result grid. Read-only. */
export function DbClientWindow({ dbId }: { dbId: string }) {
  usePopoutTheme()
  const [infoState, setInfoState] = useState<InfoState>({ status: 'loading' })
  const [run, setRun] = useState<RunState>({ status: 'idle' })
  const [database, setDatabase] = useState('')
  const [elapsed, setElapsed] = useState(0)
  const [runSeq, setRunSeq] = useState(0)
  const editorRef = useRef<CodeEditorHandle>(null)
  const runRef = useRef<() => void>(() => {})
  // Every request of this window, one after another (main refuses a second one while one runs)
  const queue = useMemo(() => createSerialQueue(), [])
  const isRunningRef = useRef(false)
  const databaseRef = useRef('')
  databaseRef.current = database
  const metadata = useMemo(() => createDbMetadata({ dbId, queue, isIdle: () => !isRunningRef.current }), [dbId, queue])
  const engine = infoState.status === 'ready' ? infoState.info.engine : null

  useEffect(() => {
    void window.electronAPI.dbInfo?.(dbId).then(result => {
      if (!result) setInfoState({ status: 'error', message: '앱을 다시 시작한 뒤에 사용할 수 있습니다.' })
      else if (!result.success) setInfoState({ status: 'error', message: result.error })
      else {
        setInfoState({ status: 'ready', info: result })
        setDatabase(result.database)
      }
    })
  }, [dbId])

  useEffect(() => {
    if (infoState.status !== 'ready') return
    const { info } = infoState
    document.title = `${info.product} ${database || info.user} - ${info.sessionName} - ezShell`
  }, [infoState, database])

  useEffect(() => {
    if (run.status !== 'running') return
    const timer = setInterval(() => setElapsed(Date.now() - run.startedAt), 200)
    return () => clearInterval(timer)
  }, [run])

  const isRunning = run.status === 'running'
  isRunningRef.current = isRunning

  const execute = async (sql: string): Promise<void> => {
    if (isRunning || !sql.trim()) return
    setElapsed(0)
    setRun({ status: 'running', sql, startedAt: Date.now() })
    const result = await queue.run(async () => window.electronAPI.dbQuery?.(dbId, sql))
    if (!result) setRun({ status: 'error', sql, message: '앱을 다시 시작한 뒤에 사용할 수 있습니다.' })
    else if (!result.success) setRun({ status: 'error', sql, message: result.error })
    else {
      // A new grid for every result: scroll position and selection belong to the old one
      setRunSeq(seq => seq + 1)
      setRun({ status: 'done', sql, result })
      setDatabase(result.database)
    }
  }

  /** The selection, or the statement the cursor is in */
  const runCurrent = (): void => {
    const view = editorRef.current?.getView()
    if (!view) return
    const { from, to, head } = view.state.selection.main
    const text = view.state.doc.toString()
    const sql = from !== to ? text.slice(from, to) : statementAt(text, head)?.text ?? ''
    void execute(sql)
  }
  runRef.current = runCurrent

  const cancel = (): void => { void window.electronAPI.dbCancel?.(dbId) }

  // Ctrl+Enter runs; fixed for the editor's life (made once the engine is known), so it calls through refs
  const extensions = useMemo(() => {
    if (engine !== 'mysql' && engine !== 'postgres') return []
    const defaultSchema = async (): Promise<string> =>
      engine === 'mysql' ? databaseRef.current : (await metadata.schemas())?.current ?? 'public'
    return [
      Prec.highest(keymap.of([{ key: 'Mod-Enter', run: () => { runRef.current(); return true } }])),
      ...completionExtensions({ engine, metadata, defaultSchema })
    ]
  }, [engine, metadata])

  const insertText = (text: string): void => {
    const view = editorRef.current?.getView()
    if (!view) return
    const { from, to } = view.state.selection.main
    view.dispatch({ changes: { from, to, insert: text }, selection: { anchor: from + text.length } })
    view.focus()
  }

  /** Adds the preview statement on its own line at the end and runs it */
  const preview = (schema: string, table: string): void => {
    const view = editorRef.current?.getView()
    if (!view || infoState.status !== 'ready') return
    const sql = previewQuery(schema, table, infoState.info.engine)
    const doc = view.state.doc
    const prefix = doc.length === 0 || doc.toString().endsWith('\n') ? '' : '\n'
    const at = doc.length + prefix.length
    view.dispatch({ changes: { from: doc.length, insert: `${prefix}${sql}\n` }, selection: { anchor: at, head: at + sql.length }, scrollIntoView: true })
    void execute(sql)
  }

  if (infoState.status !== 'ready') {
    return (
      <div className="remote-file-window">
        <PopoutTitleBar icon={<RiDatabase2Line size={16} />} title="DB" />
        <div className="remote-file-message" role={infoState.status === 'error' ? 'alert' : 'status'}>
          {infoState.status === 'loading'
            ? <><RiLoader4Line className="spinning" size={22} aria-hidden="true" /><span>접속 정보를 읽는 중…</span></>
            : <><RiErrorWarningLine size={22} className="remote-file-message-icon" aria-hidden="true" /><span>{infoState.message}</span></>}
        </div>
      </div>
    )
  }

  const { info } = infoState
  const result = run.status === 'done' ? run.result : null

  return (
    <div className="remote-file-window db-window">
      <PopoutTitleBar
        icon={<RiDatabase2Line size={16} />}
        title={`${info.product} · ${database || '(DB 선택 안 됨)'}`}
        subtitle={`${info.user}@${info.endpoint.host}:${info.endpoint.port} · ${info.sessionName}`}
      />
      <div className="db-body">
        <SchemaTree dbId={dbId} queue={queue} isIdle={!isRunning} onPreview={preview} onInsert={(name) => insertText(quoteIdentifier(name, info.engine))} />
        <div className="db-main">
          <div className="db-toolbar">
            {isRunning
              ? <button type="button" className="db-run-button is-stop" onClick={cancel}><RiStopFill size={14} /> 취소</button>
              : <button type="button" className="db-run-button" onClick={runCurrent}><RiPlayFill size={14} /> 실행 <kbd>Ctrl+Enter</kbd></button>}
            <span className="db-readonly-badge" title="DB 서버가 쓰기를 거부하도록 접속했습니다. 쿼리는 30초, 결과는 1,000행까지입니다.">
              <RiShieldCheckLine size={13} aria-hidden="true" /> 읽기 전용
            </span>
            <span className="db-server-version">{info.version}</span>
            {info.missingGuards.length > 0 && (
              <span className="db-guard-warning" title={info.missingGuards.join('\n')}>
                <RiErrorWarningLine size={13} aria-hidden="true" /> 이 서버는 일부 서버 측 제한을 지원하지 않아 앱의 제한만 적용됩니다
              </span>
            )}
          </div>
          <div className="db-editor">
            <CodeEditor ref={editorRef} initialText={INITIAL_SQL} fileName="query" readOnly={false} extensions={extensions} />
          </div>
          <section className="db-result" aria-label="결과">
            <div className="db-result-bar" role="status">
              {run.status === 'idle' && <span className="db-result-hint">실행 결과가 여기에 나옵니다.</span>}
              {run.status === 'running' && <span><RiLoader4Line className="spinning" size={13} aria-hidden="true" /> 실행 중… {(elapsed / 1000).toFixed(1)}초</span>}
              {run.status === 'done' && <span className={run.result.truncatedBy ? 'db-result-cut' : undefined}>{summary(run.result)}</span>}
              {run.status === 'error' && <span className="db-result-error"><RiErrorWarningLine size={13} aria-hidden="true" /> {run.message}</span>}
              {result && result.columns.length > 0 && (
                <button type="button" className="db-icon-button db-copy-all" onClick={() => void copyToClipboard(resultAsTsv(result.columns, result.rows))} title="결과 전체를 탭으로 구분해 복사 (엑셀에 붙여넣기)">
                  <RiFileCopyLine size={14} /> 복사
                </button>
              )}
            </div>
            {result && result.columns.length > 0 && (
              <ResultGrid key={runSeq} columns={result.columns} rows={result.rows} onCopy={(text) => void copyToClipboard(text)} />
            )}
          </section>
        </div>
      </div>
    </div>
  )
}
