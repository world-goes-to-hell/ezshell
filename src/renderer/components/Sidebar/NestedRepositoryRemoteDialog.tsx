import { useEffect, useRef, useState } from 'react'
import * as Dialog from '@radix-ui/react-dialog'
import { RiLinksLine } from 'react-icons/ri'
import type { NestedRepositoryRemote, NestedRepositoryRemoteResult } from '../../types'
import { showNestedRepositoryStatus } from '../../stores/nestedRepositoryStore'

type Note = { kind: 'busy' | 'ok' | 'error'; text: string }
type Draft = { url: string; pushUrl?: string }
interface Scope { project: string; root: string; folder: string }

const httpsOf = (url: string) => url.replace(/^http:\/\//i, 'https://')
const failure = (error: unknown, fallback: string) => error instanceof Error ? error.message : fallback

async function testAddress(scope: Scope, target: { name?: string; url?: string }): Promise<Note> {
  const result = await window.electronAPI.localNestedRepositoryTestRemote?.({ ...scope, target }).catch(() => undefined)
  return result?.success
    ? { kind: 'ok', text: `연결됨 · 브랜치 ${result.heads}개` }
    : { kind: 'error', text: result?.error ?? '원격 연결을 확인하지 못했습니다.' }
}

function NoteLine({ note }: { note?: Note }) {
  if (!note) return null
  return <p className="nested-remote-note" data-kind={note.kind} role={note.kind === 'error' ? 'alert' : 'status'}>{note.text}</p>
}

function RemoteCard({ scope, remote, busy, run }: {
  scope: Scope
  remote: NestedRepositoryRemote
  busy: boolean
  run: (task: () => Promise<NestedRepositoryRemoteResult | undefined>, done: string) => Promise<Note>
}) {
  const [draft, setDraft] = useState<Draft>({ url: remote.url, pushUrl: remote.pushUrl })
  const [note, setNote] = useState<Note>()
  const [removing, setRemoving] = useState(false)
  useEffect(() => { setDraft({ url: remote.url, pushUrl: remote.pushUrl }) }, [remote.url, remote.pushUrl])
  const urlChanged = draft.url.trim() !== remote.url
  const pushChanged = remote.pushUrl !== undefined && draft.pushUrl?.trim() !== remote.pushUrl
  const save = async () => {
    setNote({ kind: 'busy', text: '저장하는 중…' })
    setNote(await run(() => window.electronAPI.localNestedRepositorySetRemote!({ ...scope, remote: {
      name: remote.name, ...(urlChanged && { url: draft.url }), ...(pushChanged && { pushUrl: draft.pushUrl })
    } }), '저장했습니다.'))
  }
  const remove = async () => {
    if (!removing) { setRemoving(true); return }
    setNote(await run(() => window.electronAPI.localNestedRepositoryRemoveRemote!({ ...scope, name: remote.name }), ''))
  }
  const test = async () => {
    setNote({ kind: 'busy', text: '연결을 확인하는 중…' })
    setNote(await testAddress(scope, urlChanged ? { url: draft.url } : { name: remote.name }))
  }
  return <li className="nested-remote" data-remote={remote.name}>
    <div className="nested-remote-head">
      <strong>{remote.name}</strong>
      {remote.problem && <span className="nested-remote-problem">받을 수 없음</span>}
    </div>
    {remote.problem && <p className="nested-remote-note" data-kind="error">{remote.problem}</p>}
    {remote.hasPassword && <p className="nested-remote-note" data-kind="error">
      주소에 비밀번호가 저장되어 있습니다. 비밀번호를 뺀 주소로 바꾸는 것을 권합니다.</p>}
    <label className="nested-remote-field">
      <span>주소</span>
      <input type="text" spellCheck={false} value={draft.url} disabled={busy} aria-label={`${remote.name} 주소`}
        onChange={event => setDraft(current => ({ ...current, url: event.target.value }))} />
    </label>
    {remote.pushUrl !== undefined && <label className="nested-remote-field">
      <span>푸시 주소</span>
      <input type="text" spellCheck={false} value={draft.pushUrl ?? ''} disabled={busy} placeholder="비우면 주소로 푸시합니다"
        aria-label={`${remote.name} 푸시 주소`} onChange={event => setDraft(current => ({ ...current, pushUrl: event.target.value }))} />
    </label>}
    <div className="nested-remote-actions">
      {/^http:\/\//i.test(draft.url.trim()) && <button type="button" className="btn-secondary" disabled={busy}
        onClick={() => setDraft(current => ({
          url: httpsOf(current.url.trim()),
          pushUrl: current.pushUrl !== undefined ? httpsOf(current.pushUrl.trim()) : undefined
        }))}>HTTPS 로 바꾸기</button>}
      <button type="button" className="btn-secondary" disabled={busy || !draft.url.trim()} onClick={() => void test()}>연결 확인</button>
      <button type="button" className="btn-secondary nested-remote-remove" disabled={busy}
        onBlur={() => setRemoving(false)} onClick={() => void remove()}>{removing ? '한 번 더 누르면 지웁니다' : '삭제'}</button>
      <button type="button" className="btn-primary" disabled={busy || (!urlChanged && !pushChanged) || !draft.url.trim()}
        onClick={() => void save()}>저장</button>
    </div>
    <NoteLine note={note} />
  </li>
}

export function NestedRepositoryRemoteDialog({ project, root, folder, onClose }: Scope & { onClose: () => void }) {
  const scope: Scope = { project, root, folder }
  const [remotes, setRemotes] = useState<NestedRepositoryRemote[] | null>(null)
  const [loadError, setLoadError] = useState('')
  const [busy, setBusy] = useState(false)
  const [added, setAdded] = useState({ name: '', url: '' })
  const [addNote, setAddNote] = useState<Note>()
  const running = useRef(false)

  useEffect(() => {
    let active = true
    void window.electronAPI.localNestedRepositoryRemotes?.({ project, root, folder }).catch(() => undefined).then(result => {
      if (!active) return
      setRemotes(result?.success ? result.remotes : [])
      if (!result?.success) setLoadError(result?.error ?? '원격 목록을 읽지 못했습니다.')
      if (result?.success && !result.remotes.length) setAdded(current => ({ ...current, name: 'origin' }))
    })
    return () => { active = false }
  }, [project, root, folder])

  async function run(task: () => Promise<NestedRepositoryRemoteResult | undefined>, done: string): Promise<Note> {
    if (running.current) return { kind: 'error', text: '다른 작업이 끝난 뒤 다시 시도해 주세요.' }
    running.current = true
    setBusy(true)
    try {
      const result = await task()
      if (!result?.success) throw new Error(result?.error ?? '원격을 바꾸지 못했습니다.')
      setRemotes(result.remotes)
      showNestedRepositoryStatus(root, folder, result.status)
      return { kind: 'ok', text: done }
    } catch (error) {
      return { kind: 'error', text: failure(error, '원격을 바꾸지 못했습니다.') }
    } finally {
      running.current = false
      setBusy(false)
    }
  }
  const add = async () => {
    setAddNote({ kind: 'busy', text: '추가하는 중…' })
    const note = await run(() => window.electronAPI.localNestedRepositorySetRemote!({ ...scope,
      remote: { name: added.name.trim(), url: added.url, add: true } }), '추가했습니다.')
    setAddNote(note)
    if (note.kind === 'ok') setAdded({ name: '', url: '' })
  }

  return (
    <Dialog.Root open onOpenChange={open => { if (!open && !busy) onClose() }}>
      <Dialog.Portal>
        <Dialog.Overlay className="modal-overlay" />
        <Dialog.Content className="modal-content nested-branch-dialog nested-remote-dialog">
          <Dialog.Title className="modal-title"><RiLinksLine size={18} aria-hidden="true" /> 원격 주소</Dialog.Title>
          <Dialog.Description className="nested-branch-folder">
            {folder} · 받기는 HTTPS, SSH 또는 이 PC 의 경로만 사용할 수 있습니다.
          </Dialog.Description>
          {!remotes && <p className="nested-branch-message" role="status">원격을 읽는 중…</p>}
          {loadError && <p className="nested-branch-error" role="alert">{loadError}</p>}
          {remotes && remotes.length > 0 && <ul className="nested-remote-list" aria-label="원격">
            {remotes.map(remote => <RemoteCard key={remote.name} scope={scope} remote={remote} busy={busy} run={run} />)}
          </ul>}
          {remotes && !loadError && <form className="nested-remote nested-remote-add" aria-label="원격 추가"
            onSubmit={event => { event.preventDefault(); void add() }}>
            <div className="nested-remote-head"><strong>원격 추가</strong></div>
            <label className="nested-remote-field">
              <span>이름</span>
              <input type="text" spellCheck={false} value={added.name} disabled={busy} aria-label="새 원격 이름"
                onChange={event => setAdded(current => ({ ...current, name: event.target.value }))} />
            </label>
            <label className="nested-remote-field">
              <span>주소</span>
              <input type="text" spellCheck={false} value={added.url} disabled={busy} aria-label="새 원격 주소"
                placeholder="https://… 또는 git@host:path" onChange={event => setAdded(current => ({ ...current, url: event.target.value }))} />
            </label>
            <div className="nested-remote-actions">
              <button type="button" className="btn-secondary" disabled={busy || !added.url.trim()} onClick={() => {
                setAddNote({ kind: 'busy', text: '연결을 확인하는 중…' })
                void testAddress(scope, { url: added.url }).then(setAddNote)
              }}>연결 확인</button>
              <button type="submit" className="btn-primary" disabled={busy || !added.name.trim() || !added.url.trim()}>추가</button>
            </div>
            <NoteLine note={addNote} />
          </form>}
          <div className="modal-actions">
            <Dialog.Close type="button" className="btn-secondary modal-btn" disabled={busy}>닫기</Dialog.Close>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}
