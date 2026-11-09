import { useCallback, useEffect, useRef, useState } from 'react'
import { RiFileEditLine, RiHistoryLine, RiRefreshLine, RiSave3Line } from 'react-icons/ri'
import { PopoutTitleBar } from '../TitleBar/PopoutTitleBar'
import { CodeEditor, type CodeEditorHandle, type CursorInfo } from './CodeEditor'
import { ConflictDialog, SaveReviewDialog, type ConflictChoice, type SaveReview } from './RemoteFileDialogs'
import { RemoteBackupPanel } from './RemoteBackupPanel'
import { LINE_ENDING_LABELS, detectLineEnding, fileNameOf, fromEditorText, toEditorText, type LineEnding } from '../../lib/remoteFileText'
import { confirmDialog } from '../../stores/confirmStore'
import { toast } from '../../stores/toastStore'

interface EditableFile {
  sessionName: string
  path: string
  content: string
  canWrite: boolean
}

interface RemoteTextEditViewProps {
  docId: string
  file: EditableFile
}

interface PendingSave {
  review: SaveReview
  content: string
  token: string
}

/** Ending used when saving: a mixed file is saved with LF (the status bar says so). */
const savedEnding = (ending: LineEnding): LineEnding => (ending === 'crlf' ? 'crlf' : 'lf')

/**
 * Editing a server file. Ctrl+S shows the change, then main backs up the server's content on this PC
 * and saves only when the file is still what was opened.
 */
export function RemoteTextEditView({ docId, file }: RemoteTextEditViewProps) {
  const api = window.electronAPI
  const editorRef = useRef<CodeEditorHandle>(null)
  const [canWrite, setCanWrite] = useState(file.canWrite)
  const [ending, setEnding] = useState<LineEnding>(() => detectLineEnding(file.content))
  const [isDirty, setIsDirty] = useState(false)
  const [pending, setPending] = useState<PendingSave | null>(null)
  const [isSaving, setIsSaving] = useState(false)
  const [hasConflict, setHasConflict] = useState(false)
  const [showBackups, setShowBackups] = useState(false)
  const [backupVersion, setBackupVersion] = useState(0)
  const [cursor, setCursor] = useState<CursorInfo>({ line: 1, column: 1, selected: 0 })
  const isBusy = useRef(false)

  useEffect(() => {
    api.remoteFileSetDirty?.(docId, isDirty)
  }, [api, docId, isDirty])

  // Closing with unsaved changes: main holds the window and asks here
  useEffect(() => api.onRemoteFileCloseRequested?.(() => {
    void confirmDialog({
      title: '저장하지 않은 변경',
      message: '저장하지 않은 변경이 있습니다. 저장하지 않고 닫을까요?',
      confirmLabel: '저장하지 않고 닫기',
      danger: true
    }).then((confirmed) => { if (confirmed) void api.remoteFileClose?.(docId) })
  }), [api, docId])

  const startSave = useCallback(async () => {
    if (isBusy.current || !editorRef.current) return
    if (!canWrite) {
      toast.warning('읽기 전용', '접속 계정에 이 파일을 쓸 권한이 없습니다.')
      return
    }
    isBusy.current = true
    try {
      const content = fromEditorText(editorRef.current.getText(), savedEnding(ending))
      const result = await api.remoteFileReview?.(docId, content)
      if (!result) return
      if (!result.success) {
        toast.error('저장하지 못했습니다', result.error)
        return
      }
      if (result.unchanged) {
        editorRef.current.markSaved()
        toast.info('바뀐 내용이 없습니다')
        return
      }
      setPending({ review: result.change, content, token: result.token })
    } finally {
      isBusy.current = false
    }
  }, [api, canWrite, docId, ending])

  const confirmSave = async () => {
    if (!pending) return
    setIsSaving(true)
    const result = await api.remoteFileSave?.(docId, pending.content, pending.token)
    setIsSaving(false)
    setPending(null)
    if (!result) return
    if (!result.success) {
      toast.error('저장하지 못했습니다', result.error)
      return
    }
    if (!result.ok) {
      setHasConflict(true)
      return
    }
    editorRef.current?.markSaved()
    setEnding(savedEnding(ending))
    setBackupVersion(version => version + 1)
    toast.success('저장했습니다', `저장 전 내용은 PC 에 백업했습니다 (${result.backupName}).`)
  }

  /** Read the server file again: into the editor ('reload'), or only as the new base of the comparison. */
  const readServer = async (intoEditor: boolean) => {
    const result = await api.remoteFileLoad?.(docId)
    if (!result) return false
    if (!result.success || result.kind !== 'text' || !result.editable) {
      toast.error('파일을 다시 읽지 못했습니다', result.success ? undefined : result.error)
      return false
    }
    setCanWrite(result.canWrite)
    if (intoEditor) {
      setEnding(detectLineEnding(result.content))
      editorRef.current?.setText(toEditorText(result.content), { asBaseline: true })
    } else {
      editorRef.current?.setBaseline(toEditorText(result.content))
    }
    return true
  }

  const chooseOnConflict = async (choice: ConflictChoice) => {
    setHasConflict(false)
    if (choice === 'reload') {
      if (await readServer(true)) toast.info('서버 내용을 다시 불러왔습니다')
    } else if (choice === 'compare') {
      if (await readServer(false)) await startSave()
    }
  }

  const reloadFromServer = async () => {
    if (isDirty) {
      const confirmed = await confirmDialog({
        title: '서버에서 다시 불러오기',
        message: '저장하지 않은 변경을 버리고 서버의 지금 내용을 불러올까요?',
        confirmLabel: '변경 버리고 불러오기',
        danger: true
      })
      if (!confirmed) return
    }
    if (await readServer(true)) toast.info('서버 내용을 다시 불러왔습니다')
  }

  const restoreBackup = (content: string) => {
    editorRef.current?.setText(toEditorText(content))
    editorRef.current?.focus()
    toast.info('백업 내용을 편집기에 넣었습니다', 'Ctrl+S 로 저장해야 서버에 반영됩니다.')
  }

  const name = fileNameOf(file.path)
  const actions = (
    <>
      <button type="button" className="title-bar-btn popout-title-action" onClick={() => void reloadFromServer()} title="서버에서 다시 불러오기" aria-label="서버에서 다시 불러오기">
        <RiRefreshLine size={16} />
      </button>
      <button type="button" className={`title-bar-btn popout-title-action${showBackups ? ' is-active' : ''}`} onClick={() => setShowBackups(open => !open)} title="백업" aria-label="백업" aria-pressed={showBackups}>
        <RiHistoryLine size={16} />
      </button>
      <button type="button" className="title-bar-btn popout-title-action" onClick={() => void startSave()} disabled={!canWrite} title="저장 (Ctrl+S)" aria-label="저장">
        <RiSave3Line size={16} />
      </button>
    </>
  )

  return (
    <div className="remote-file-window">
      <PopoutTitleBar icon={<RiFileEditLine size={16} />} title={`${isDirty ? '● ' : ''}${name}`} subtitle={`${file.sessionName} · ${file.path}`} actions={actions} />
      {!canWrite && <div className="remote-file-banner">읽기 전용: 접속 계정에 이 파일을 쓸 권한이 없습니다.</div>}
      <div className="remote-file-body">
        <CodeEditor
          ref={editorRef}
          initialText={toEditorText(file.content)}
          fileName={name}
          readOnly={!canWrite}
          onDirtyChange={setIsDirty}
          onSave={() => void startSave()}
          onCursor={setCursor}
        />
        {showBackups && <RemoteBackupPanel docId={docId} version={backupVersion} onRestore={restoreBackup} onClose={() => setShowBackups(false)} />}
      </div>
      <div className="remote-file-status">
        <span>{isDirty ? '저장하지 않은 변경 있음' : '저장됨'}</span>
        <span className="remote-file-status-spacer" />
        <span>줄 {cursor.line}, 열 {cursor.column}{cursor.selected > 0 ? ` (${cursor.selected}자 선택)` : ''}</span>
        <span title={ending === 'mixed' ? '줄바꿈이 섞여 있어 저장하면 LF 로 통일됩니다' : undefined}>{LINE_ENDING_LABELS[ending]}</span>
        <span>UTF-8</span>
        <span className="remote-file-status-keys">Ctrl+F 찾기 · Ctrl+H 바꾸기 · Ctrl+G 줄 이동 · Ctrl+S 저장</span>
      </div>
      <SaveReviewDialog review={pending?.review ?? null} path={file.path} isSaving={isSaving} onConfirm={() => void confirmSave()} onCancel={() => setPending(null)} />
      <ConflictDialog isOpen={hasConflict} onChoose={(choice) => void chooseOnConflict(choice)} />
    </div>
  )
}
