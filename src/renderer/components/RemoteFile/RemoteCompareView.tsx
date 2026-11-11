import { useEffect, useRef, useState } from 'react'
import { EditorView } from '@codemirror/view'
import { EditorState, type Extension } from '@codemirror/state'
import { MergeView, getChunks, goToNextChunk, goToPreviousChunk } from '@codemirror/merge'
import { RiArrowDownSLine, RiArrowUpSLine, RiCloseLine, RiSkipDownLine, RiSkipUpLine } from 'react-icons/ri'
import { editorExtensions, languageFor, languageSlot } from './codeEditorSetup'
import { BackupSourceIcon } from './RemoteBackupPanel'
import { entryKey, neighborOf, readBackupEntry, type BackupEntry } from '../../lib/backupCompare'
import { formatClock, toEditorText } from '../../lib/remoteFileText'
import { toast } from '../../stores/toastStore'
import './RemoteCompare.css'

/** Same limit as the editor: above it no syntax colours (the parser stutters on huge files) */
const LANGUAGE_MAX_CHARS = 1_000_000
/** Exact diffing gives up after this and falls back to a rougher one (same budget as the save review) */
const DIFF_TIMEOUT_MS = 300

interface RemoteCompareViewProps {
  docId: string
  fileName: string
  entries: BackupEntry[]
  backupKey: string
  onBackupKey: (key: string) => void
  /** The file window's editor: the right side starts from its text and sends every change back to it */
  getEditor: () => EditorView | null
  readOnly: boolean
  onSave: () => void
  onClose: () => void
}

type Loaded = { key: string; content: string } | { key: string; error: string } | null

// Labels the merge view reads from the editors' phrases
const MERGE_PHRASES = EditorState.phrases.of({
  'Revert this chunk': '이 부분을 백업 내용으로 바꾸기',
  '$ unchanged lines': '같은 줄 $개 (눌러서 펼치기)'
})

const optionLabel = (entry: BackupEntry): string =>
  entry.source === 'app' ? `앱 · ${formatClock(entry.time)}` : `서버 · ${entry.name}`

/**
 * IntelliJ-style comparison: the backup on the left (read-only), the editor's text on the right.
 * » between them takes a changed block from the backup. The right side is a second view of the same
 * text: every change made there (arrows, typing, undo) is sent to the file window's editor at once,
 * so saving, the unsaved-changes prompt and Ctrl+Z there keep working without a separate "apply".
 */
export function RemoteCompareView({ docId, fileName, entries, backupKey, onBackupKey, getEditor, readOnly, onSave, onClose }: RemoteCompareViewProps) {
  const hostRef = useRef<HTMLDivElement>(null)
  const mergeRef = useRef<MergeView | null>(null)
  const [loaded, setLoaded] = useState<Loaded>(null)
  const [collapse, setCollapse] = useState(true)
  const [chunkCount, setChunkCount] = useState<number | null>(null)
  const onSaveRef = useRef(onSave)
  onSaveRef.current = onSave
  const onCloseRef = useRef(onClose)
  onCloseRef.current = onClose

  const entry = entries.find(e => entryKey(e) === backupKey) ?? null
  const older = neighborOf(entries, backupKey, 'older')
  const newer = neighborOf(entries, backupKey, 'newer')

  // The compared backup left the list (old app backups are pruned, a server file was deleted): take the newest
  useEffect(() => {
    if (entry) return
    if (entries.length > 0) onBackupKey(entryKey(entries[0]))
    else onClose()
  }, [entry, entries, onBackupKey, onClose])

  useEffect(() => {
    if (!entry) return
    let isCurrent = true
    setLoaded(null)
    void readBackupEntry(docId, entry).then((result) => {
      if (!isCurrent) return
      setLoaded('content' in result ? { key: backupKey, content: result.content } : { key: backupKey, error: result.error })
    })
    return () => { isCurrent = false }
    // entry is looked up from backupKey; re-reading on a new list object would flicker
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [docId, backupKey])

  useEffect(() => {
    const host = hostRef.current
    const editor = getEditor()
    if (!host || !editor || !loaded || !('content' in loaded)) return
    const backupText = toEditorText(loaded.content)
    const noop = () => {}
    const sendToEditor: Extension = EditorView.updateListener.of((update) => {
      // Both sides of the mirror hold the same text; a length mismatch means the editor changed elsewhere
      if (update.docChanged) {
        if (editor.state.doc.length === update.startState.doc.length) {
          editor.dispatch({ changes: update.changes, userEvent: 'input.compare' })
        } else {
          // Never drop an edit silently: leave the comparison so the editor's text is what the user sees
          toast.warning('비교를 닫았습니다', '편집기 내용이 따로 바뀌어 비교 화면과 맞지 않습니다. 편집기에서 확인해 주세요.')
          onCloseRef.current()
        }
      }
      const chunks = getChunks(update.state)
      if (chunks) setChunkCount(chunks.chunks.length)
    })
    const merge = new MergeView({
      a: { doc: backupText, extensions: [editorExtensions({ readOnly: true }, noop, noop), MERGE_PHRASES] },
      b: {
        doc: editor.state.doc,
        extensions: [editorExtensions({ readOnly, onSave: () => onSaveRef.current() }, noop, noop), MERGE_PHRASES, sendToEditor]
      },
      parent: host,
      renderRevertControl: () => {
        const button = document.createElement('button')
        button.textContent = '»'
        button.title = '이 부분을 백업 내용으로 바꾸기'
        button.setAttribute('aria-label', '이 부분을 백업 내용으로 바꾸기')
        return button
      },
      // Taking a block from the backup only; the backup itself never changes
      revertControls: readOnly ? undefined : 'a-to-b',
      highlightChanges: true,
      gutter: true,
      collapseUnchanged: collapse ? { margin: 3, minSize: 4 } : undefined,
      diffConfig: { scanLimit: 500, timeout: DIFF_TIMEOUT_MS }
    })
    mergeRef.current = merge
    setChunkCount(merge.chunks.length)

    let isCancelled = false
    const bigger = Math.max(backupText.length, editor.state.doc.length)
    void (bigger <= LANGUAGE_MAX_CHARS ? languageFor(fileName) : Promise.resolve(null)).then((language) => {
      if (isCancelled || !language) return
      merge.a.dispatch({ effects: languageSlot.reconfigure(language) })
      merge.b.dispatch({ effects: languageSlot.reconfigure(language) })
    })
    merge.b.focus()
    return () => {
      isCancelled = true
      merge.destroy()
      mergeRef.current = null
    }
  }, [loaded, collapse, getEditor, readOnly, fileName])

  const goChunk = (direction: 'previous' | 'next') => {
    const view = mergeRef.current?.b
    if (!view) return
    ;(direction === 'next' ? goToNextChunk : goToPreviousChunk)(view)
    view.focus()
  }

  const summary = chunkCount === null ? '' : chunkCount === 0 ? '현재 내용과 같습니다' : `바뀐 곳 ${chunkCount}개`

  return (
    <section className="remote-compare" aria-label="백업과 비교">
      <div className="remote-compare-toolbar">
        <label className="remote-compare-pick">
          <span className="remote-compare-label">백업</span>
          <select value={backupKey} onChange={(e) => onBackupKey(e.target.value)}>
            {entries.map(e => <option key={entryKey(e)} value={entryKey(e)}>{optionLabel(e)}</option>)}
          </select>
        </label>
        <button type="button" className="remote-file-icon-btn" disabled={!newer} onClick={() => newer && onBackupKey(newer)} title="더 최근 백업" aria-label="더 최근 백업">
          <RiArrowUpSLine size={17} />
        </button>
        <button type="button" className="remote-file-icon-btn" disabled={!older} onClick={() => older && onBackupKey(older)} title="더 오래된 백업" aria-label="더 오래된 백업">
          <RiArrowDownSLine size={17} />
        </button>
        <span className="remote-compare-divider" aria-hidden="true" />
        <button type="button" className="remote-file-icon-btn" disabled={!chunkCount} onClick={() => goChunk('previous')} title="이전 변경" aria-label="이전 변경">
          <RiSkipUpLine size={16} />
        </button>
        <button type="button" className="remote-file-icon-btn" disabled={!chunkCount} onClick={() => goChunk('next')} title="다음 변경" aria-label="다음 변경">
          <RiSkipDownLine size={16} />
        </button>
        <span className="remote-compare-summary" role="status">{summary}</span>
        <span className="remote-compare-spacer" />
        <label className="remote-compare-check">
          <input type="checkbox" checked={collapse} onChange={(e) => setCollapse(e.target.checked)} />
          <span>같은 줄 접기</span>
        </label>
        <button type="button" className="btn-secondary remote-compare-close" onClick={onClose}>
          <RiCloseLine size={14} aria-hidden="true" /> 비교 닫기
        </button>
      </div>
      <div className="remote-compare-heads" aria-hidden="true">
        <div className="remote-compare-head">
          {entry && <BackupSourceIcon entry={entry} size={13} />}
          <span>{entry ? optionLabel(entry) : '백업'}</span>
          <span className="remote-compare-tag">읽기 전용</span>
        </div>
        <div className="remote-compare-head">
          <span>현재 편집기</span>
          <span className="remote-compare-tag">{readOnly ? '읽기 전용' : '저장 안 한 변경 포함 · » 로 가져오기'}</span>
        </div>
      </div>
      {loaded && 'error' in loaded && <p className="remote-compare-message" role="alert">{loaded.error}</p>}
      {!loaded && <p className="remote-compare-message">백업을 읽는 중…</p>}
      <div className="remote-compare-host" ref={hostRef} />
    </section>
  )
}
