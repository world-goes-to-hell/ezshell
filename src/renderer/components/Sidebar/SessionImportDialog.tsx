import { useEffect, useMemo, useState } from 'react'
import * as Dialog from '@radix-ui/react-dialog'
import { RiClipboardLine, RiFolderFill, RiErrorWarningLine, RiKey2Line, RiLockLine, RiLoader4Line } from 'react-icons/ri'
import { useSessionStore } from '../../stores/sessionStore'
import { toast } from '../../stores/toastStore'
import { getFolderPath } from '../../lib/folderPath'
import {
  findShareToken, materializeFolder, parseShareText, unlockShare,
  type ParseResult, type SharedFolder, type SharedSession
} from '../../lib/sessionShare'
import { ShareUnlockError } from '../../lib/shareCrypto'
import './SessionImportDialog.css'

interface SessionImportDialogProps {
  /** Folder to add into (undefined = top level) */
  folderId?: string
  onClose: () => void
  /** One session goes through the usual new-connection form, so passwords and keys are entered there */
  onOpenSession: (session: SharedSession, folderId?: string) => void
}

interface ScriptEntry { name: string; script: string }

/** Sessions in a folder tree that run a start-up script, for the warning */
function scriptsIn(folder: SharedFolder, path: string): ScriptEntry[] {
  const here = folder.sessions
    .filter(s => s.postConnectScript?.trim())
    .map(s => ({ name: `${path}${s.name}`, script: s.postConnectScript as string }))
  return [...here, ...folder.folders.flatMap(child => scriptsIn(child, `${path}${child.name} / `))]
}

function countKeySessions(folder: SharedFolder): number {
  return folder.sessions.filter(s => s.authType === 'privateKey').length
    + folder.folders.reduce((sum, child) => sum + countKeySessions(child), 0)
}

function FolderTree({ folder }: { folder: SharedFolder }) {
  return (
    <li>
      <span className="session-import-tree-folder"><RiFolderFill size={13} aria-hidden="true" /> {folder.name}</span>
      <ul>
        {folder.folders.map((child, index) => <FolderTree key={`f${index}`} folder={child} />)}
        {folder.sessions.map((session, index) => (
          <li key={`s${index}`} className="session-import-tree-session">
            {session.name} <span>{session.username}@{session.host}:{session.port}</span>
          </li>
        ))}
      </ul>
    </li>
  )
}

type Parsed = Extract<ParseResult, { ok: true }>

function SecretState({ parsed }: { parsed: Parsed }) {
  if (!parsed.hasSecrets) return <>없음 (편집 창에서 넣습니다)</>
  if (parsed.locked) return <span className="session-import-secret"><RiLockLine size={13} aria-hidden="true" /> 암호화됨 (아래에서 공유 암호로 풉니다)</span>
  return <span className="session-import-secret is-open"><RiKey2Line size={13} aria-hidden="true" /> 풀림</span>
}

/** Passphrase input for sealed passwords */
function UnlockForm({ onUnlock, error, isBusy }: { onUnlock: (passphrase: string) => void; error: string | null; isBusy: boolean }) {
  const [passphrase, setPassphrase] = useState('')
  return (
    <form className="session-import-unlock" onSubmit={(e) => { e.preventDefault(); if (passphrase) onUnlock(passphrase) }}>
      <label htmlFor="session-import-passphrase">공유 암호</label>
      <div className="session-import-unlock-row">
        <input
          id="session-import-passphrase"
          type="password"
          value={passphrase}
          onChange={(e) => setPassphrase(e.target.value)}
          placeholder="보낸 사람에게 따로 받은 공유 암호"
          autoComplete="off"
          disabled={isBusy}
        />
        <button type="submit" className="btn-secondary modal-btn" disabled={isBusy || !passphrase}>
          {isBusy ? <RiLoader4Line className="spinning" size={14} aria-hidden="true" /> : <RiLockLine size={14} aria-hidden="true" />} 풀기
        </button>
      </div>
      {error && <p className="session-import-error" role="alert">{error}</p>}
    </form>
  )
}

const lineCount = (script: string) => script.split('\n').length

/**
 * Every start-up script in full (no inner scroll box a payload could hide below), with its line
 * count, and a checkbox the user must tick before adding.
 */
function ScriptWarning({ entries, reviewed, onReviewed }: { entries: ScriptEntry[]; reviewed: boolean; onReviewed: (value: boolean) => void }) {
  if (entries.length === 0) return null
  return (
    <div className="session-import-script" role="note">
      <p><RiErrorWarningLine size={15} aria-hidden="true" /> 접속할 때마다 서버에서 자동으로 실행되는 명령이 {entries.length > 1 ? `세션 ${entries.length}개에 ` : ''}들어 있습니다. 끝까지 읽고 확인해 주세요.</p>
      {entries.map((entry, index) => (
        <div key={index}>
          <strong>{entries.length > 1 ? `${entry.name} · ` : ''}{lineCount(entry.script)}줄</strong>
          <pre>{entry.script}</pre>
        </div>
      ))}
      <label className="session-import-script-check">
        <input type="checkbox" checked={reviewed} onChange={(e) => onReviewed(e.target.checked)} />
        자동 실행 명령을 모두 읽었고, 이대로 추가합니다
      </label>
    </div>
  )
}

/**
 * Adds a session or a whole folder from text copied with "연결 정보 복사". The text is someone
 * else's, so it is checked by lib/sessionShare and shown before anything is saved.
 */
export function SessionImportDialog({ folderId, onClose, onOpenSession }: SessionImportDialogProps) {
  const [text, setText] = useState('')
  const folders = useSessionStore(state => state.folders)
  const parsed = useMemo(() => (text.trim() ? parseShareText(text) : null), [text])
  // The parsed text with its passwords opened, for the same `parsed` only
  const [unlocked, setUnlocked] = useState<{ from: ParseResult; result: Parsed } | null>(null)
  const [unlockError, setUnlockError] = useState<string | null>(null)
  const [isUnlocking, setIsUnlocking] = useState(false)
  const view: Parsed | null = unlocked && unlocked.from === parsed ? unlocked.result : parsed?.ok ? parsed : null
  const isLocked = Boolean(view?.locked)
  const scripts: ScriptEntry[] = !view ? []
    : view.kind === 'session'
      ? (view.session.postConnectScript?.trim() ? [{ name: view.session.name, script: view.session.postConnectScript }] : [])
      : scriptsIn(view.folder, '')
  // The tick belongs to this exact text; pasting something else asks again
  const [reviewedText, setReviewedText] = useState<string | null>(null)
  const scriptsReviewed = scripts.length === 0 || reviewedText === text
  const scriptWarning = <ScriptWarning entries={scripts} reviewed={reviewedText === text} onReviewed={(value) => setReviewedText(value ? text : null)} />
  const placeName = folderId && folders.some(f => f.id === folderId) ? getFolderPath(folders, folderId) : '최상위'

  // Fill from the clipboard when it already holds session text
  useEffect(() => {
    let cancelled = false
    navigator.clipboard.readText()
      .then(clip => { if (!cancelled && findShareToken(clip)) setText(clip) })
      .catch(() => { /* no clipboard access: the user pastes */ })
    return () => { cancelled = true }
  }, [])

  const addFolder = async (shared: SharedFolder): Promise<void> => {
    const store = useSessionStore.getState()
    const made = materializeFolder(shared, folderId && store.folders.some(f => f.id === folderId) ? folderId : undefined)
    store.setFolders([...store.folders, ...made.folders])
    store.setSessions([...store.sessions, ...made.sessions])
    for (const id of [folderId, made.rootId]) {
      if (id && !useSessionStore.getState().expandedFolders.has(id)) store.toggleFolder(id)
    }
    await store.saveToBackend()
    toast.success('폴더를 추가했습니다', `${shared.name} · 세션 ${made.sessions.length}개`)
    onClose()
  }

  const unlock = async (passphrase: string): Promise<void> => {
    if (!parsed?.ok) return
    const from = parsed
    setIsUnlocking(true)
    setUnlockError(null)
    try {
      setUnlocked({ from, result: await unlockShare(from, passphrase) })
    } catch (error) {
      setUnlockError(error instanceof ShareUnlockError ? '공유 암호가 맞지 않습니다. (텍스트가 바뀌었어도 이렇게 보입니다)' : '비밀번호를 풀지 못했습니다.')
    } finally {
      setIsUnlocking(false)
    }
  }

  /** Adds what is shown; sealed passwords that were not opened are left out */
  const confirm = (): void => {
    if (!view || !scriptsReviewed) return
    if (view.kind === 'session') {
      onOpenSession(view.session, folderId)
      onClose()
    } else {
      void addFolder(view.folder)
    }
  }

  return (
    <Dialog.Root open onOpenChange={(isOpen) => { if (!isOpen) onClose() }}>
      <Dialog.Portal>
        <Dialog.Overlay className="modal-overlay" />
        <Dialog.Content className="modal-content session-import-dialog" aria-describedby="session-import-note">
          <Dialog.Title className="modal-title">
            <RiClipboardLine size={18} aria-hidden="true" />
            텍스트로 세션 추가
          </Dialog.Title>
          <p id="session-import-note" className="session-import-note">
            다른 사람이 &quot;연결 정보 복사&quot; 로 보낸 텍스트를 붙여 넣으세요. 추가할 위치: <strong>{placeName}</strong>
          </p>
          <textarea
            className="session-import-text"
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder={'[ezShell 세션] ...\nezshell-session:v1:...'}
            spellCheck={false}
            autoFocus
            rows={4}
          />

          {parsed && !parsed.ok && <p className="session-import-error" role="alert">{parsed.error}</p>}

          {parsed?.ok && parsed.kind === 'session' && (
            <div className="session-import-preview">
              <dl>
                <dt>이름</dt><dd>{parsed.session.name}</dd>
                <dt>주소</dt><dd className="mono">{parsed.session.username}@{parsed.session.host}:{parsed.session.port}</dd>
                <dt>인증</dt><dd>{parsed.session.authType === 'privateKey' ? '개인 키 (키 파일은 직접 고릅니다)' : '비밀번호'}</dd>
                {parsed.session.useJumpHost && parsed.session.jumpHost && (
                  <><dt>점프 호스트</dt><dd className="mono">{parsed.session.jumpUsername}@{parsed.session.jumpHost}:{parsed.session.jumpPort ?? 22}</dd></>
                )}
                {parsed.session.suRoot && <><dt>root 전환</dt><dd>로그인 후 su -</dd></>}
                <dt>비밀번호</dt><dd><SecretState parsed={view ?? parsed} /></dd>
              </dl>
              {scriptWarning}
            </div>
          )}

          {parsed?.ok && parsed.kind === 'folder' && (
            <div className="session-import-preview">
              <p className="session-import-summary">
                폴더 <strong>{parsed.folder.name}</strong> · 하위 폴더 {parsed.folderCount}개, 세션 {parsed.sessionCount}개 ·
                비밀번호 <SecretState parsed={view ?? parsed} />
              </p>
              <ul className="session-import-tree"><FolderTree folder={parsed.folder} /></ul>
              {(!parsed.hasSecrets || isLocked) && <p className="session-import-hint">비밀번호가 없는 세션은 접속하기 전에 수정에서 넣어 주세요.</p>}
              {countKeySessions(parsed.folder) > 0 && (
                <p className="session-import-hint">개인 키로 접속하는 세션 {countKeySessions(parsed.folder)}개는 수정에서 키 파일을 골라 주세요.</p>
              )}
              {scriptWarning}
            </div>
          )}

          {isLocked && <UnlockForm key={text} onUnlock={(p) => void unlock(p)} error={unlockError} isBusy={isUnlocking} />}

          <div className="modal-actions">
            <button type="button" className="btn-secondary modal-btn" onClick={onClose}>취소</button>
            {isLocked && (
              <button type="button" className="btn-secondary modal-btn" onClick={confirm} disabled={isUnlocking || !scriptsReviewed}>
                비밀번호 없이 추가
              </button>
            )}
            <button type="button" className="btn-primary modal-btn" onClick={confirm} disabled={!view || isLocked || isUnlocking || !scriptsReviewed}>
              {view?.kind === 'folder' ? '폴더 추가' : '세션 편집에서 열기'}
            </button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}
