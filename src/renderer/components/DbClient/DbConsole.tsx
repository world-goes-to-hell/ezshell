import { forwardRef, useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react'
import { Prec, type Extension } from '@codemirror/state'
import { EditorView, keymap } from '@codemirror/view'
import { RiErrorWarningLine, RiFileCopyLine, RiLoader4Line } from 'react-icons/ri'
import { CodeEditor, type CodeEditorHandle } from '../RemoteFile/CodeEditor'
import { ResultGrid, resultAsTsv } from './ResultGrid'
import { copyToClipboard } from '../../lib/terminalClipboard'
import { statementAt } from '../../lib/sqlStatements'
import type { DbQueryResult, DbResult } from '../../types/db'

type RunState =
  | { status: 'idle' }
  | { status: 'running'; startedAt: number }
  | { status: 'done'; result: DbQueryResult }
  | { status: 'error'; message: string }

export interface DbConsoleHandle {
  /** Runs the selection, or the statement at the cursor */
  runCurrent: () => void
  /** Adds `sql` on its own line at the end, selects it and runs it */
  appendAndRun: (sql: string) => void
  insertText: (text: string) => void
  focus: () => void
}

interface DbConsoleProps {
  consoleId: string
  initialSql: string
  isActive: boolean
  /** Another console (or a database switch) is busy: this one waits */
  isBlocked: boolean
  /** Completion and dialect, fixed for the editor's life */
  extensions: Extension[]
  runQuery: (sql: string) => Promise<DbResult<DbQueryResult> | undefined>
  onRunningChange: (consoleId: string, isRunning: boolean) => void
  onSqlChange: (consoleId: string, sql: string) => void
}

function summary(result: DbQueryResult): string {
  const seconds = (result.elapsedMs / 1000).toFixed(2)
  if (result.columns.length === 0) {
    return result.affectedRows !== null ? `완료 · ${result.affectedRows}행 · ${seconds}초` : `완료 · ${seconds}초`
  }
  const cut = result.truncatedBy === 'rows' ? ' · 처음 1,000행만 받았습니다' : result.truncatedBy === 'bytes' ? ' · 50MB 를 넘어 일부만 받았습니다' : ''
  return `${result.rows.length.toLocaleString()}행 · ${seconds}초${cut}`
}

/**
 * One query console of a DB tab: its own editor, result and run state. Consoles share the tab's
 * connection, so only one runs at a time (the others are blocked meanwhile).
 */
export const DbConsole = forwardRef<DbConsoleHandle, DbConsoleProps>(function DbConsole(props, ref) {
  const { consoleId, initialSql, isActive, isBlocked } = props
  const [run, setRun] = useState<RunState>({ status: 'idle' })
  const [runSeq, setRunSeq] = useState(0)
  const [elapsed, setElapsed] = useState(0)
  const editorRef = useRef<CodeEditorHandle>(null)
  const callbacks = useRef(props)
  callbacks.current = props
  const isRunning = run.status === 'running'

  useEffect(() => {
    if (run.status !== 'running') return
    const timer = setInterval(() => setElapsed(Date.now() - run.startedAt), 200)
    return () => clearInterval(timer)
  }, [run])

  const execute = async (sql: string): Promise<void> => {
    if (isRunning || callbacks.current.isBlocked || !sql.trim()) return
    setElapsed(0)
    setRun({ status: 'running', startedAt: Date.now() })
    callbacks.current.onRunningChange(consoleId, true)
    const result = await callbacks.current.runQuery(sql)
    callbacks.current.onRunningChange(consoleId, false)
    if (!result) setRun({ status: 'error', message: '앱을 다시 시작한 뒤에 사용할 수 있습니다.' })
    else if (!result.success) setRun({ status: 'error', message: result.error })
    else {
      // A new grid for every result: scroll position and selection belong to the old one
      setRunSeq(seq => seq + 1)
      setRun({ status: 'done', result })
    }
  }

  const runCurrent = (): void => {
    const view = editorRef.current?.getView()
    if (!view) return
    const { from, to, head } = view.state.selection.main
    const text = view.state.doc.toString()
    void execute(from !== to ? text.slice(from, to) : statementAt(text, head)?.text ?? '')
  }
  const runRef = useRef(runCurrent)
  runRef.current = runCurrent

  useImperativeHandle(ref, () => ({
    runCurrent: () => runRef.current(),
    appendAndRun: (sql) => {
      const view = editorRef.current?.getView()
      if (!view) return
      const doc = view.state.doc
      const prefix = doc.length === 0 || doc.toString().endsWith('\n') ? '' : '\n'
      const at = doc.length + prefix.length
      view.dispatch({ changes: { from: doc.length, insert: `${prefix}${sql}\n` }, selection: { anchor: at, head: at + sql.length }, scrollIntoView: true })
      void execute(sql)
    },
    insertText: (text) => {
      const view = editorRef.current?.getView()
      if (!view) return
      const { from, to } = view.state.selection.main
      view.dispatch({ changes: { from, to, insert: text }, selection: { anchor: from + text.length } })
      view.focus()
    },
    focus: () => editorRef.current?.focus()
  }))

  // Ctrl+Enter runs; the text is reported for the drafts kept on this PC
  const extensions = useMemo(() => [
    Prec.highest(keymap.of([{ key: 'Mod-Enter', run: () => { runRef.current(); return true } }])),
    EditorView.updateListener.of((update) => {
      if (update.docChanged) callbacks.current.onSqlChange(consoleId, update.state.doc.toString())
    }),
    ...props.extensions
    // Fixed for the editor's life
    // eslint-disable-next-line react-hooks/exhaustive-deps
  ], [])

  useEffect(() => {
    if (isActive) editorRef.current?.focus()
  }, [isActive])

  const result = run.status === 'done' ? run.result : null

  return (
    <div className={`db-console${isActive ? '' : ' is-hidden'}`} role="tabpanel" aria-hidden={!isActive}>
      <div className="db-editor">
        <CodeEditor ref={editorRef} initialText={initialSql} fileName="query" readOnly={false} extensions={extensions} />
      </div>
      <section className="db-result" aria-label="결과">
        <div className="db-result-bar" role="status">
          {run.status === 'idle' && <span className="db-result-hint">{isBlocked ? '다른 콘솔의 쿼리가 끝나면 실행할 수 있습니다.' : '실행 결과가 여기에 나옵니다.'}</span>}
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
  )
})
