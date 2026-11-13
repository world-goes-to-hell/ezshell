import { useEffect, useMemo, useState } from 'react'
import * as Dialog from '@radix-ui/react-dialog'
import { RiDownloadCloud2Line, RiFileSearchLine, RiFolderAddLine, RiLoader4Line, RiRefreshLine } from 'react-icons/ri'
import { useSessionStore } from '../../stores/sessionStore'
import { toast } from '../../stores/toastStore'
import {
  addStagedFolder, duplicateIds, initialSelection, mergeOrder, removeStaged, stageAll, stageNode, EMPTY_STAGE,
  type Anchor, type ImportNode, type ImportResult, type Stage
} from '../../lib/externalImport'
import { ImportTree, MyTree } from './ExternalImportTrees'
import './ExternalImport.css'

type Source = { id: string; label: string; detail: string }

const newId = () => crypto.randomUUID()

// The window is newer than main (the dev renderer reloads at once; main and preload only on a
// restart), or an old build: say so instead of "no program found" or a button that does nothing
const RESTART_NOTE = '가져오기 기능이 아직 앱에 올라오지 않았습니다. 앱을 완전히 닫았다가 다시 실행해 주세요.'
const isMissingHandler = (error: unknown) => /No handler registered/i.test(String((error as Error)?.message ?? error))

/**
 * "다른 프로그램에서 가져오기": the user's sessions on the left, another program's on the right.
 * Folders and sessions are dragged across (or the checked ones are put into the selected folder),
 * and nothing is saved until 적용 / 모두 적용. Passwords are not imported (phase 1).
 */
export function ExternalImportDialog({ onClose }: { onClose: () => void }) {
  const folders = useSessionStore(state => state.folders)
  const sessions = useSessionStore(state => state.sessions)
  const [sources, setSources] = useState<Source[] | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [result, setResult] = useState<ImportResult | null>(null)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [stage, setStage] = useState<Stage>(EMPTY_STAGE)
  const [target, setTarget] = useState<string | null>(null)
  const [needsRestart, setNeedsRestart] = useState(false)
  // "새 폴더": the name being typed (null = no input shown)
  const [newFolderName, setNewFolderName] = useState<string | null>(null)

  const duplicates = useMemo(() => (result ? duplicateIds(result, sessions) : new Set<string>()), [result, sessions])
  const stagedImported = useMemo(() => new Set(stage.sessions.map(s => s.importedId)), [stage])

  const loadSources = async () => {
    const api = window.electronAPI.sessionImportSources
    if (typeof api !== 'function') {
      setNeedsRestart(true)
      setSources([])
      return
    }
    setBusy('sources')
    let missing = false
    const answer = await api().catch((err) => {
      missing = isMissingHandler(err)
      return { ok: false as const, error: '이 PC 의 프로그램을 찾는 중에 오류가 났습니다.' }
    })
    setBusy(null)
    if (missing) {
      setNeedsRestart(true)
      setSources([])
    } else if (answer.ok) setSources(answer.sources)
    else {
      setSources([])
      setError(answer.error)
    }
  }

  useEffect(() => { void loadSources() }, [])

  const show = (next: ImportResult) => {
    setResult(next)
    setSelected(initialSelection(next, useSessionStore.getState().sessions))
    setStage(EMPTY_STAGE)
    setError(null)
  }

  const readSource = async (id: string) => {
    setBusy(id)
    setError(null)
    const answer = await window.electronAPI.sessionImportRead?.(id).catch(() => ({ ok: false as const, error: '읽지 못했습니다.' }))
    setBusy(null)
    if (answer?.ok) show(answer.result)
    else setError(answer?.error ?? '읽지 못했습니다.')
  }

  const pickFile = async () => {
    setBusy('file')
    setError(null)
    const api = window.electronAPI.sessionImportFile
    if (typeof api !== 'function') {
      setBusy(null)
      setNeedsRestart(true)
      return
    }
    let missing = false
    const answer = await api().catch((err) => {
      missing = isMissingHandler(err)
      return { ok: false as const, error: '파일을 읽지 못했습니다.' }
    })
    setBusy(null)
    if (missing) {
      setNeedsRestart(true)
      return
    }
    if (!answer.ok) setError(answer.error)
    else if (!answer.canceled) show(answer.result)
  }

  const toggle = (ids: string[], on: boolean) => setSelected(prev => {
    const next = new Set(prev)
    for (const id of ids) {
      if (on) next.add(id)
      else next.delete(id)
    }
    return next
  })

  const drop = (node: ImportNode, folderId: string | null, anchor?: Anchor) => {
    if (!result) return
    setStage(prev => stageNode(prev, { result, node, targetFolderId: folderId, anchor, selected, newId }))
  }

  const allFolders = [...folders, ...stage.folders]
  const targetName = target ? allFolders.find(f => f.id === target)?.name ?? '최상위' : '최상위'

  /** A folder made here goes under the selected folder and becomes the place to put things */
  const createFolder = () => {
    const name = newFolderName ?? ''
    const next = addStagedFolder(stage, { name, parentId: target, newId })
    if (next !== stage) {
      setStage(next)
      setTarget(next.folders[next.folders.length - 1].id)
    }
    setNewFolderName(null)
  }

  /** The checked items (top-level folders and loose sessions) into the selected folder: the keyboard way */
  const putChecked = () => {
    if (!result) return
    let next = stage
    for (const folder of result.folders.filter(f => f.parentId === null)) {
      next = stageNode(next, { result, node: { type: 'folder', id: folder.id }, targetFolderId: target, selected, newId })
    }
    for (const session of result.sessions.filter(s => s.folderId === null && selected.has(s.id))) {
      next = stageNode(next, { result, node: { type: 'session', id: session.id }, targetFolderId: target, selected, newId })
    }
    setStage(next)
  }

  const commit = async (toAdd: Stage) => {
    if (toAdd.sessions.length === 0 && toAdd.folders.length === 0) return
    const store = useSessionStore.getState()
    store.setFolders([...store.folders, ...toAdd.folders])
    // In the order shown (dropped next to a session = saved next to it); staging fields are dropped
    const ordered = mergeOrder(store.sessions, toAdd.sessions)
    store.setSessions(ordered.map((session) => {
      if (!('importedId' in session)) return session
      const { importedId: _imported, anchor: _anchor, ...plain } = session
      return plain
    }))
    await store.saveToBackend()
    toast.success('세션을 가져왔습니다', `${result?.label ?? ''} · 세션 ${toAdd.sessions.length}개${toAdd.sessions.some(s => s.authType === 'password') ? ' · 비밀번호는 접속할 때 입력하세요' : ''}`)
    onClose()
  }

  const applyAll = () => {
    if (!result) return
    void commit(stageAll({ result, selected, newId }))
  }

  const skippedText = result
    ? Object.entries(result.skipped).map(([reason, count]) => `${reason} ${count}개`).join(', ')
    : ''

  return (
    <Dialog.Root open onOpenChange={(isOpen) => { if (!isOpen) onClose() }}>
      <Dialog.Portal>
        <Dialog.Overlay className="modal-overlay" />
        <Dialog.Content className="modal-content xi-dialog" aria-describedby="xi-note"
          // Esc in the folder name box closes only the box, not the dialog (and what is staged)
          onEscapeKeyDown={(e) => { if (newFolderName !== null) { e.preventDefault(); setNewFolderName(null) } }}>
          <Dialog.Title className="modal-title"><RiDownloadCloud2Line size={18} aria-hidden="true" /> 다른 프로그램에서 가져오기</Dialog.Title>
          <p id="xi-note" className="xi-note">
            Xshell·Xftp·PuTTY·MobaXterm·Tabby·OpenSSH config 의 세션을 옮겨 옵니다. 호스트·포트·계정·폴더·점프 호스트·키 파일 경로만 가져오고, <strong>저장된 비밀번호는 가져오지 않습니다</strong> (접속할 때 입력). Termius 는 OpenSSH config 로 내보낸 파일을 고르세요.
          </p>

          <div className="xi-sources">
            {sources === null && <span className="xi-muted"><RiLoader4Line className="spinning" size={14} /> 이 PC 에서 찾는 중…</span>}
            {sources?.map(source => (
              <button key={source.id} type="button" className={`xi-source${result?.label === source.label ? ' is-active' : ''}`} onClick={() => void readSource(source.id)} disabled={busy !== null} title={source.detail}>
                {busy === source.id ? <RiLoader4Line className="spinning" size={14} /> : null}{source.label}
              </button>
            ))}
            {sources?.length === 0 && !needsRestart && <span className="xi-muted">이 PC 에서 찾은 프로그램이 없습니다 (Xshell·PuTTY·MobaXterm·Tabby 가 세션을 저장하는 기본 위치를 봤습니다). 받은 파일은 '파일 고르기' 로 여세요.</span>}
            <button type="button" className="xi-source is-file" onClick={() => void pickFile()} disabled={busy !== null}>
              {busy === 'file' ? <RiLoader4Line className="spinning" size={14} /> : <RiFileSearchLine size={14} />} 파일 고르기…
            </button>
            <button type="button" className="xi-icon-btn" onClick={() => void loadSources()} disabled={busy !== null} aria-label="다시 찾기" title="다시 찾기">
              <RiRefreshLine size={15} />
            </button>
          </div>
          {needsRestart && <p className="xi-error" role="alert">{RESTART_NOTE}</p>}
          {error && <p className="xi-error" role="alert">{error}</p>}

          <div className="xi-panels">
            <section className="xi-panel">
              <header className="xi-panel-head">
                <span>내 세션 <span className="xi-muted">폴더를 눌러 고르거나, 폴더 안·세션 사이에 끌어 놓으세요</span></span>
                <button type="button" className="xi-head-btn" onClick={() => setNewFolderName('')} title={`${targetName} 아래에 새 폴더`}>
                  <RiFolderAddLine size={14} /> 새 폴더
                </button>
              </header>
              {newFolderName !== null && (
                <form className="xi-new-folder" onSubmit={(e) => { e.preventDefault(); createFolder() }}>
                  <input autoFocus value={newFolderName} maxLength={100} placeholder={`${targetName} 아래에 만들 폴더 이름`}
                    onChange={(e) => setNewFolderName(e.target.value)}
                  />
                  <button type="submit" className="btn-primary modal-btn" disabled={!newFolderName.trim()}>만들기</button>
                  <button type="button" className="btn-secondary modal-btn" onClick={() => setNewFolderName(null)}>취소</button>
                </form>
              )}
              <MyTree folders={folders} sessions={sessions} stage={stage} target={target} onTarget={setTarget} onDrop={drop}
                onRemove={(node) => setStage(prev => removeStaged(prev, node))} />
            </section>
            <section className="xi-panel">
              <header>
                가져온 세션{result && <span className="xi-muted"> · {result.label} · 세션 {result.sessions.length}개{skippedText ? ` · 건너뜀: ${skippedText}` : ''}{result.truncated ? ' · 한도까지만 읽음' : ''}</span>}
              </header>
              {result
                ? (result.sessions.length > 0
                    ? <ImportTree result={result} selected={selected} duplicates={duplicates} staged={stagedImported} onToggle={toggle} />
                    : <p className="xi-empty">가져올 SSH 세션이 없습니다.</p>)
                : <p className="xi-empty">위에서 프로그램을 고르거나 파일을 여세요.</p>}
            </section>
          </div>

          <div className="modal-actions xi-actions">
            <span className="xi-muted">추가 예정: 폴더 {stage.folders.length}개 · 세션 {stage.sessions.length}개</span>
            <span className="xi-spacer" />
            <button type="button" className="btn-secondary modal-btn" onClick={putChecked} disabled={!result || selected.size === 0}>← 선택 항목 넣기</button>
            <button type="button" className="btn-secondary modal-btn" onClick={onClose}>취소</button>
            <button type="button" className="btn-secondary modal-btn" onClick={applyAll} disabled={!result || selected.size === 0} title="체크한 세션을 모두 새 폴더 하나에 넣고 저장합니다">모두 적용</button>
            <button type="button" className="btn-primary modal-btn" onClick={() => void commit(stage)} disabled={stage.sessions.length === 0 && stage.folders.length === 0}>적용</button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}
