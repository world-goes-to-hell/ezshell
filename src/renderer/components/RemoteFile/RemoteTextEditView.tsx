import { useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState, type Ref } from 'react'
import { createPortal } from 'react-dom'
import { RiFileEditLine, RiHistoryLine, RiRefreshLine, RiSave3Line } from 'react-icons/ri'
import { PopoutTitleBar } from '../TitleBar/PopoutTitleBar'
import { CodeEditor, type CodeEditorHandle, type CursorInfo } from './CodeEditor'
import { FileShortcutHelp } from './FileShortcutHelp'
import { ConflictDialog, SaveReviewDialog, type ConflictChoice, type SaveReview } from './RemoteFileDialogs'
import { RemoteBackupPanel } from './RemoteBackupPanel'
import { RemoteCompareView } from './RemoteCompareView'
import { useBackupEntries } from './useBackupEntries'
import { MarkdownPreview } from './MarkdownPreview'
import { MarkdownDivider, MarkdownViewSwitch, useMarkdownView } from './markdownView'
import { isMarkdownFile } from '../../lib/markdownRender'
import { LINE_ENDING_LABELS, detectLineEnding, fileNameOf, fromEditorText, toEditorText, type LineEnding } from '../../lib/remoteFileText'
import { confirmDialog } from '../../stores/confirmStore'
import { toast } from '../../stores/toastStore'
import { placeholderLinks, revealEditorLine, revealedLine, type PlaceholderHit } from './placeholderLinks'
import { DefinitionList, type DefinitionState } from './DefinitionList'
import { entryKey } from '../../lib/backupCompare'
import type { RemoteFileDraft, RemoteFileOpenHint } from '../../types'

/** The comparison entry of a local file's version at Git HEAD (documents.js listServerBackups) */
const HEAD_KEY = entryKey({ source: 'server', name: 'HEAD' })

interface EditableFile {
  sessionName: string
  path: string
  content: string
  canWrite: boolean
  /** A file on this PC: the comparison list comes from Git. */
  local?: true
  /** Opened from a placeholder's definitions: go to this line once */
  revealLine?: number
  /** Opened from the uncommitted changes: start comparing with Git HEAD */
  compareHead?: true
  draft?: RemoteFileDraft
}

export interface RemoteTextEditHandle {
  snapshot: () => RemoteFileDraft | null
}

interface RemoteTextEditViewProps {
  docId: string
  file: EditableFile
  active: boolean
  header: HTMLElement | null
  hint?: RemoteFileOpenHint
  ref?: Ref<RemoteTextEditHandle>
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
export function RemoteTextEditView({ docId, file, active, header, hint, ref }: RemoteTextEditViewProps) {
  const api = window.electronAPI
  const editorRef = useRef<CodeEditorHandle>(null)
  const [canWrite, setCanWrite] = useState(file.canWrite)
  const [ending, setEnding] = useState<LineEnding>(() => file.draft?.ending ?? detectLineEnding(file.content))
  const [isDirty, setIsDirty] = useState(false)
  const [pending, setPending] = useState<PendingSave | null>(null)
  const [isSaving, setIsSaving] = useState(false)
  const [hasConflict, setHasConflict] = useState(false)
  const [showBackups, setShowBackups] = useState(false)
  const isLocal = file.local === true
  const reloadLabel = isLocal ? '파일에서 다시 불러오기' : '서버에서 다시 불러오기'
  const reloadSuccess = isLocal ? '파일 내용을 다시 불러왔습니다' : '서버 내용을 다시 불러왔습니다'
  const backupLabel = isLocal ? 'Git 이력 비교' : '백업'
  const readOnlyMessage = isLocal ? '이 파일을 쓸 권한이 없습니다.' : '접속 계정에 이 파일을 쓸 권한이 없습니다.'
  const [backupVersion, setBackupVersion] = useState(0)
  const [selectedBackup, setSelectedBackup] = useState<string | null>(null)
  const [isComparing, setIsComparing] = useState(false)
  const backups = useBackupEntries(docId, backupVersion, showBackups || isComparing)
  const getEditor = useCallback(() => editorRef.current?.getView() ?? null, [])
  const [cursor, setCursor] = useState<CursorInfo>({ line: 1, column: 1, selected: 0 })
  const isBusy = useRef(false)
  const isReloading = useRef(false)
  // Where a placeholder's name (`${NAME}`) is set: the list shown after Ctrl + click on it
  const [definition, setDefinition] = useState<(Omit<PlaceholderHit, 'x' | 'y'> & { at: { x: number; y: number }; state: DefinitionState }) | null>(null)
  const findRequest = useRef(0)

  const openDefinition = useCallback(async (key: string) => {
    setDefinition(null)
    const result = await api.remoteFileOpenDefinition?.(docId, key)
    if (result && !result.success) toast.error('파일을 열지 못했습니다', result.error)
  }, [api, docId])

  const findDefinitions = useCallback(async (hit: PlaceholderHit) => {
    const request = ++findRequest.current
    setDefinition({ name: hit.name, fallback: hit.fallback, at: { x: hit.x, y: hit.y }, state: { status: 'loading' } })
    const result = await api.remoteFileFindDefinitions?.(docId, hit.name).catch(() => null)
    if (request !== findRequest.current) return
    if (!result || !result.success) {
      setDefinition(current => current && { ...current, state: { status: 'error', message: result && !result.success ? result.error : '찾지 못했습니다.' } })
      return
    }
    // One place sets it: go there at once
    if (result.results.length === 1 && !result.truncated) {
      void openDefinition(result.results[0].key)
      return
    }
    setDefinition(current => current && { ...current, state: { status: 'ready', results: result.results, truncated: result.truncated } })
  }, [api, docId, openDefinition])
  const findRef = useRef(findDefinitions)
  findRef.current = findDefinitions

  useImperativeHandle(ref, () => ({
    snapshot: () => {
      if (isBusy.current || isReloading.current || isSaving || pending || hasConflict) return null
      const snapshot = editorRef.current?.snapshot()
      return snapshot ? { ...snapshot, ending } : null
    }
  }), [ending, isSaving, pending, hasConflict])

  // The window routes open requests to the document they refer to.
  const revealLine = hint?.line ?? file.revealLine
  const hintSequence = hint?.sequence
  useEffect(() => {
    if (!revealLine) return
    const frame = requestAnimationFrame(() => {
      const view = editorRef.current?.getView()
      if (view) revealEditorLine(view, revealLine)
    })
    return () => cancelAnimationFrame(frame)
  }, [revealLine, hintSequence])
  // Opened from the uncommitted changes: compare with the last commit at once (no search for it first)
  const [wantsHead, setWantsHead] = useState(Boolean(file.compareHead))
  const compareHead = hint?.compareHead
  useEffect(() => {
    if (compareHead) setWantsHead(true)
  }, [compareHead, hintSequence])

  const reportDirty = (dirty: boolean) => {
    setIsDirty(dirty)
    api.remoteFileSetDirty?.(docId, dirty)
  }
  useEffect(() => {
    if (file.draft) api.remoteFileDraftRestored?.(docId)
  }, [api, docId, file.draft])

  const startSave = useCallback(async () => {
    if (isBusy.current || !editorRef.current) return
    if (!canWrite) {
      toast.warning('읽기 전용', readOnlyMessage)
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
  }, [api, canWrite, docId, ending, readOnlyMessage])

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
    if (result.backupName) toast.success('저장했습니다', `저장 전 내용은 PC 에 백업했습니다 (${result.backupName}).`)
    else toast.success('저장했습니다')
  }

  /** Read the file into the editor or use it as the new base of the comparison. */
  const readFile = async (intoEditor: boolean) => {
    if (isReloading.current) return false
    isReloading.current = true
    try {
      const result = await api.remoteFileLoad?.(docId)
      if (!result) return false
      if (!result.success || result.kind !== 'text' || !result.editable) {
        toast.error('파일을 다시 읽지 못했습니다', result.success ? undefined : result.error)
        return false
      }
      setCanWrite(result.canWrite)
      if (intoEditor) {
        // The comparison's right side mirrors the editor; a whole new text would leave it out of step
        setIsComparing(false)
        setEnding(detectLineEnding(result.content))
        editorRef.current?.setText(toEditorText(result.content), { asBaseline: true })
      } else {
        editorRef.current?.setBaseline(toEditorText(result.content))
      }
      return true
    } finally {
      isReloading.current = false
    }
  }

  const chooseOnConflict = async (choice: ConflictChoice) => {
    setHasConflict(false)
    if (choice === 'reload') {
      if (await readFile(true)) toast.info(reloadSuccess)
    } else if (choice === 'compare') {
      if (await readFile(false)) await startSave()
    }
  }

  const reloadFromFile = async () => {
    if (isDirty) {
      const confirmed = await confirmDialog({
        title: reloadLabel,
        message: isLocal
          ? '저장하지 않은 변경을 버리고 디스크의 현재 내용을 불러올까요?'
          : '저장하지 않은 변경을 버리고 서버의 지금 내용을 불러올까요?',
        confirmLabel: '변경 버리고 불러오기',
        danger: true
      })
      if (!confirmed) return
    }
    if (await readFile(true)) toast.info(reloadSuccess)
  }

  const compareWith = (key: string) => {
    setSelectedBackup(key)
    setIsComparing(true)
  }

  // The HEAD entry comes with the comparison list; start once it is there (or say why not)
  useEffect(() => {
    if (!wantsHead) return
    if (!isComparing) {
      setSelectedBackup(HEAD_KEY)
      setIsComparing(true)
      return
    }
    if (!backups.entries) return
    setWantsHead(false)
    if (!backups.entries.some(entry => entryKey(entry) === HEAD_KEY)) {
      setIsComparing(false)
      toast.info('마지막 커밋에 없는 파일입니다', '비교할 이전 내용이 없어 파일만 열었습니다.')
    }
  }, [wantsHead, isComparing, backups.entries])

  const closeCompare = () => {
    setIsComparing(false)
    // The editor was hidden meanwhile: let it measure again before it takes the keyboard
    requestAnimationFrame(() => editorRef.current?.focus())
  }

  const restoreBackup = (content: string) => {
    editorRef.current?.setText(toEditorText(content))
    editorRef.current?.focus()
    const title = isLocal ? 'Git 내용을 편집기에 넣었습니다' : '백업 내용을 편집기에 넣었습니다'
    toast.info(title, isLocal ? 'Ctrl+S로 저장하면 로컬 파일에 반영됩니다.' : 'Ctrl+S 로 저장해야 서버에 반영됩니다.')
  }

  const name = fileNameOf(file.path, file.local)
  // Markdown files: the editor, the document, or both side by side (markdownView.tsx)
  const isMarkdown = isMarkdownFile(name)
  const markdown = useMarkdownView(editorRef, isMarkdown, isComparing)
  // Fixed for the editor's life: side by side, the document follows the typing
  const markdownExtensions = useMemo(() => [
    markdown.followTyping,
    placeholderLinks(hit => void findRef.current(hit)),
    revealedLine
  ], [markdown.followTyping])
  const editorHidden = isComparing || markdown.mode === 'markdown'
  const actions = (
    <>
      {isMarkdown && <MarkdownViewSwitch mode={markdown.mode} onMode={markdown.setMode} />}
      <button type="button" className="title-bar-btn popout-title-action" onClick={() => void reloadFromFile()} title={reloadLabel} aria-label={reloadLabel}>
        <RiRefreshLine size={16} />
      </button>
      <button type="button" className={`title-bar-btn popout-title-action${showBackups ? ' is-active' : ''}`} onClick={() => setShowBackups(open => !open)} title={backupLabel} aria-label={backupLabel} aria-pressed={showBackups}>
        <RiHistoryLine size={16} />
      </button>
      <button type="button" className="title-bar-btn popout-title-action" onClick={() => void startSave()} disabled={!canWrite} title="저장 (Ctrl+S)" aria-label="저장">
        <RiSave3Line size={16} />
      </button>
    </>
  )

  return (
    <div className="remote-file-window">
      {active && header && createPortal(<PopoutTitleBar icon={<RiFileEditLine size={16} />} title={`${isDirty ? '● ' : ''}${name}`} subtitle={`${file.sessionName} · ${file.path}`} actions={actions} />, header)}
      {!canWrite && <div className="remote-file-banner">읽기 전용 · {readOnlyMessage}</div>}
      <div className="remote-file-body" ref={markdown.bodyRef} data-markdown-mode={markdown.mode}>
        {/* Kept mounted while comparing: it holds the text, the undo history and the unsaved state */}
        <div className="remote-edit-pane" hidden={editorHidden} style={markdown.mode === 'split' ? { flex: `0 0 ${markdown.split * 100}%` } : undefined}>
          <CodeEditor
            ref={editorRef}
            initialText={toEditorText(file.content)}
            fileName={name}
            readOnly={!canWrite}
            initialSnapshot={file.draft}
            autoFocus={active}
            onDirtyChange={reportDirty}
            onSave={() => void startSave()}
            onCursor={setCursor}
            extensions={markdownExtensions}
          />
        </div>
        {active && definition && (
          <DefinitionList
            name={definition.name}
            fallback={definition.fallback}
            at={definition.at}
            state={definition.state}
            isLocal={Boolean(file.local)}
            onPick={(key) => void openDefinition(key)}
            onClose={() => { findRequest.current++; setDefinition(null) }}
          />
        )}
        {markdown.mode === 'split' && <MarkdownDivider onPointerDown={markdown.startDrag} onReset={markdown.resetSplit} />}
        {markdown.mode !== 'code' && <MarkdownPreview text={markdown.text} />}
        {isComparing && selectedBackup && backups.entries && (!wantsHead || backups.entries.some(entry => entryKey(entry) === HEAD_KEY)) && (
          <RemoteCompareView
            docId={docId}
            fileName={name}
            entries={backups.entries}
            backupKey={selectedBackup}
            onBackupKey={setSelectedBackup}
            getEditor={getEditor}
            readOnly={!canWrite}
            onSave={() => void startSave()}
            onClose={closeCompare}
          />
        )}
        {showBackups && !isComparing && (
          <RemoteBackupPanel
            docId={docId}
            entries={backups.entries}
            error={backups.error}
            selectedKey={selectedBackup}
            onSelect={setSelectedBackup}
            onRestore={restoreBackup}
            onCompare={compareWith}
            onClose={() => setShowBackups(false)}
            isLocal={file.local === true}
          />
        )}
      </div>
      <div className="remote-file-status">
        <div className="remote-file-status-details">
          <span>{isDirty ? '저장하지 않은 변경 있음' : '저장됨'}</span>
          <span className="remote-file-status-spacer" />
          <span>줄 {cursor.line}, 열 {cursor.column}{cursor.selected > 0 ? ` (${cursor.selected}자 선택)` : ''}</span>
          <span title={ending === 'mixed' ? '줄바꿈이 섞여 있어 저장하면 LF 로 통일됩니다' : undefined}>{LINE_ENDING_LABELS[ending]}</span>
          <span>UTF-8</span>
        </div>
        {active && <FileShortcutHelp view="editor" />}
      </div>
      <SaveReviewDialog review={active ? pending?.review ?? null : null} path={file.path} isLocal={isLocal} isSaving={isSaving} onConfirm={() => void confirmSave()} onCancel={() => setPending(null)} />
      <ConflictDialog isOpen={active && hasConflict} isLocal={isLocal} onChoose={(choice) => void chooseOnConflict(choice)} />
    </div>
  )
}
