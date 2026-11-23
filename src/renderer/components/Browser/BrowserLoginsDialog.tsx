import { useEffect, useId, useState, type FormEvent } from 'react'
import * as Dialog from '@radix-ui/react-dialog'
import { RiKey2Line } from 'react-icons/ri'
import type { BrowserLoginAction, BrowserLoginResult, BrowserLoginSource } from '../../types'
import { confirmDialog } from '../../stores/confirmStore'
import { toast } from '../../stores/toastStore'

type LoginResult = Extract<BrowserLoginResult, { success: true }>

const exportInstructions: Record<BrowserLoginSource['id'], string> = {
  chrome: 'Chrome 비밀번호 관리자에서 ‘비밀번호 내보내기’ 옆의 ‘파일 다운로드’를 누르세요.',
  edge: 'Edge 암호 관리자에서 더보기(⋯)를 열고 ‘암호 내보내기’를 선택하세요.',
  firefox: 'Firefox 비밀번호 관리자에서 더보기(⋯)를 열고 비밀번호 내보내기를 선택하세요.',
}

function importNotice(imported: number, skipped = 0) {
  return `${imported}개를 가져왔습니다.${skipped ? ` 중복되거나 가져올 수 없는 ${skipped}개 항목은 건너뛰었습니다.` : ''}`
}

export function BrowserLoginsDialog({ tabId, origin, onClose, trigger }: {
  tabId: string
  origin: string | null
  onClose: () => void
  trigger: HTMLButtonElement | null
}) {
  const [state, setState] = useState<LoginResult | null>(null)
  const [adding, setAdding] = useState(false)
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [query, setQuery] = useState('')
  const [limit, setLimit] = useState(100)
  const [showImport, setShowImport] = useState(false)
  const [sources, setSources] = useState<BrowserLoginSource[] | null>(null)
  const [sourceId, setSourceId] = useState('')
  const [exportBrowser, setExportBrowser] = useState<BrowserLoginSource['id'] | null>(null)
  const [autoImport, setAutoImport] = useState(false)
  const [transfer, setTransfer] = useState<{ profileId: string; browser: BrowserLoginSource['id'] } | null>(null)
  const [importId, setImportId] = useState('')
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState('')
  const [error, setError] = useState('')
  const fieldId = useId()
  const selectedSource = sources?.find(source => source.profiles.some(profile => profile.id === sourceId))
  const exportSource = transfer?.browser ?? exportBrowser

  useEffect(() => {
    let mounted = true
    void window.electronAPI.browserReviewLogins(tabId, { type: 'list' }).then(result => {
      if (!mounted) return
      if (result.success) setState(result)
      else setError(result.error)
    }).catch(() => { if (mounted) setError('로그인 정보를 열 수 없습니다.') })
    return () => { mounted = false }
  }, [tabId])

  useEffect(() => {
    setAdding(false)
    setUsername('')
    setPassword('')
  }, [origin])

  useEffect(() => {
    if (!transfer) return
    let active = true
    let id = ''
    const call = (request: BrowserLoginAction) => window.electronAPI.browserReviewLogins(tabId, request)
    const cancel = () => { if (id) void call({ type: 'cancel-import', importId: id }).catch(() => {}) }
    void (async () => {
      try {
        const started = await call({ type: 'start-import', id: transfer.profileId })
        if (started.success) id = started.importId ?? ''
        if (!active) { cancel(); return }
        if (!started.success) { setError(started.error); return }
        setImportId(id)
        const result = await call({ type: 'finish-import', importId: id })
        if (!active) return
        if (!result.success) { setError(result.error); return }
        setNotice(importNotice(result.imported ?? 0, result.skipped))
        if (result.imported) setShowImport(false)
        const next = await call({ type: 'list' })
        if (active && next.success) setState(next)
      } catch {
        if (active) setError('비밀번호 가져오기를 완료할 수 없습니다. 다시 시도해 주세요.')
      } finally {
        if (active) {
          setTransfer(null)
          setImportId('')
        }
      }
    })()
    return () => { active = false; cancel() }
  }, [tabId, transfer])

  async function perform(action: BrowserLoginAction) {
    if (busy) return
    setBusy(true)
    setError('')
    setNotice('')
    try {
      const call = (request: BrowserLoginAction) => window.electronAPI.browserReviewLogins(tabId, request)
      const result = await call(action)
      if (!result.success) { setError(result.error); return }
      if (action.type === 'sources') {
        const next = result.sources ?? []
        setSources(next)
        setAutoImport(result.autoImport === true)
        setSourceId(current => next.some(source => source.profiles.some(profile => profile.id === current))
          ? current : next[0]?.profiles[0]?.id ?? '')
        return
      }
      if (action.type === 'open-source') {
        if (selectedSource) setExportBrowser(selectedSource.id)
        return
      }
      if (action.type === 'copy-import-path') { setNotice('저장 경로를 복사했습니다.'); return }
      if (action.type === 'fill') {
        toast.success('로그인 입력란을 채웠습니다.')
        onClose()
        return
      }
      if (action.type === 'save') {
        setAdding(false)
        setUsername('')
        setPassword('')
        setNotice('로그인 정보를 저장했습니다.')
      }
      if (action.type === 'import') {
        if (result.imported === undefined) return
        if (result.imported > 0) setShowImport(false)
        setNotice(`${importNotice(result.imported, result.skipped)} 내보낸 CSV 파일은 가져오기가 끝난 뒤 삭제해 주세요.`)
      }
      if (action.type === 'clear-session') setNotice('저장된 사이트 데이터를 지웠습니다.')
      const next = await call({ type: 'list' })
      if (next.success) setState(next)
      else setError(next.error)
    } catch {
      setError('로그인 작업을 완료할 수 없습니다. 다시 시도해 주세요.')
    } finally {
      setBusy(false)
    }
  }

  function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (origin && password) void perform({ type: 'save', origin, username, password })
  }

  function toggleImport() {
    setShowImport(!showImport)
    setTransfer(null)
    setImportId('')
    if (!showImport) {
      setExportBrowser(null)
      setSources(null)
      void perform({ type: 'sources' })
    }
  }

  function startImport() {
    if (!selectedSource || transfer) return
    if (!autoImport) { void perform({ type: 'open-source', id: sourceId }); return }
    setError('')
    setNotice('')
    setTransfer({ profileId: sourceId, browser: selectedSource.id })
  }

  async function remove(id: string) {
    if (await confirmDialog({ title: '저장된 로그인 삭제', message: '선택한 계정을 ezShell의 저장 목록에서 삭제하시겠습니까?', confirmLabel: '삭제', danger: true })) {
      await perform({ type: 'remove', id })
    }
  }

  async function clearSession() {
    if (await confirmDialog({ title: '저장된 사이트 데이터 지우기', message: '내장 브라우저에 보관된 사이트 데이터가 삭제되어 다시 로그인해야 할 수 있습니다.', confirmLabel: '지우기', danger: true })) {
      await perform({ type: 'clear-session' })
    }
  }

  const search = query.trim().toLocaleLowerCase()
  const accounts = (state?.accounts ?? []).filter(account =>
    `${account.origin} ${account.username}`.toLocaleLowerCase().includes(search)
  ).sort((a, b) => Number(b.origin === origin) - Number(a.origin === origin) || a.origin.localeCompare(b.origin) || a.username.localeCompare(b.username))

  return (
    <Dialog.Root open onOpenChange={open => { if (!open && !busy) onClose() }}>
      <Dialog.Portal>
        <Dialog.Overlay className="modal-overlay" />
        <Dialog.Content className="modal-content browser-login-dialog" aria-describedby={undefined}
          onCloseAutoFocus={event => { event.preventDefault(); trigger?.focus({ preventScroll: true }) }}>
          <Dialog.Title className="modal-title"><RiKey2Line size={20} />로그인 정보</Dialog.Title>
          <section className="browser-login-session">
            <label><input type="checkbox" checked={state?.rememberSession === true} disabled={!state || busy}
              onChange={event => void perform({ type: 'remember', enabled: event.target.checked })} /> 로그인 상태 유지</label>
            <button type="button" className="btn-secondary" disabled={!state || busy} onClick={() => void clearSession()}>저장된 사이트 데이터 지우기</button>
            {state && state.sessionPersistent !== state.rememberSession && <p>변경한 설정은 새 브라우저 탭부터 적용됩니다.</p>}
          </section>
          <section className="browser-login-accounts">
            <div className="browser-login-heading">
              <h2>저장된 계정</h2>
              <div className="browser-login-heading-actions">
                <button type="button" className="btn-secondary" disabled={!state || busy} aria-expanded={showImport}
                  aria-controls={`${fieldId}-import`} onClick={toggleImport}>다른 브라우저에서 가져오기</button>
                <button type="button" className="btn-primary" disabled={!state || busy || !origin || adding} onClick={() => setAdding(true)}>이 사이트 계정 추가</button>
              </div>
            </div>
            {showImport && (
              <div className="browser-login-import" id={`${fieldId}-import`}>
                {exportSource ? (
                  <>
                    <strong>{transfer ? '브라우저에서 내보내기 대기 중' : '내보낸 비밀번호 가져오기'}</strong>
                    <p role="status">{exportInstructions[exportSource]} {transfer
                      ? '내보내기를 승인한 뒤 저장 창의 파일 이름에 복사된 경로를 붙여넣고 저장하세요. 저장하면 자동으로 가져옵니다.'
                      : '저장한 CSV 파일을 여기서 선택하세요.'}</p>
                  </>
                ) : sources?.length ? (
                  <>
                    <label htmlFor={`${fieldId}-source`}>가져올 브라우저 프로필</label>
                    <select id={`${fieldId}-source`} value={sourceId} disabled={busy} onChange={event => setSourceId(event.target.value)}>
                      {sources.flatMap(source => source.profiles.map(profile => (
                        <option key={profile.id} value={profile.id}>{source.name} · {profile.name}</option>
                      )))}
                    </select>
                    <p>{autoImport
                      ? '가져오기를 누르면 저장 경로가 복사됩니다. 브라우저에서 내보내기를 승인하고 그 경로로 저장하세요.'
                      : '선택한 브라우저에서 비밀번호를 내보낸 뒤, 저장한 파일을 가져옵니다.'}</p>
                  </>
                ) : (sources || busy) && (
                  <p role="status">{sources ? '감지된 브라우저가 없습니다. 브라우저에서 비밀번호를 내보낸 뒤 CSV 파일을 선택하세요.' : '설치된 브라우저를 찾는 중…'}</p>
                )}
                <div className="browser-login-import-actions">
                  {transfer ? <>
                    <button type="button" className="btn-secondary" onClick={() => { setTransfer(null); setImportId(''); setNotice('') }}>취소</button>
                    <button type="button" className="btn-secondary" disabled={!importId || busy}
                      onClick={() => void perform({ type: 'copy-import-path', importId })}>저장 경로 다시 복사</button>
                  </> : <>
                    {exportBrowser && <button type="button" className="btn-secondary" disabled={busy} onClick={() => setExportBrowser(null)}>프로필 다시 선택</button>}
                    <button type="button" className={selectedSource && !exportBrowser ? 'btn-secondary' : 'btn-primary'}
                      disabled={busy} onClick={() => void perform({ type: 'import' })}>CSV 파일 선택…</button>
                    {selectedSource && !exportBrowser && (
                      <button type="button" className="btn-primary" disabled={busy} onClick={startImport}>
                        {autoImport ? '가져오기' : '내보내기 화면 열기'}
                      </button>
                    )}
                  </>}
                </div>
              </div>
            )}
            {adding && origin && (
              <form className="browser-login-form" onSubmit={save} autoComplete="off">
                <strong>{origin}</strong>
                <div className="form-group">
                  <label htmlFor={`${fieldId}-user`}>아이디</label>
                  <input id={`${fieldId}-user`} value={username} maxLength={1024} disabled={busy} onChange={event => setUsername(event.target.value)} />
                </div>
                <div className="form-group">
                  <label htmlFor={`${fieldId}-password`}>비밀번호</label>
                  <input id={`${fieldId}-password`} type="password" autoComplete="new-password" value={password}
                    maxLength={4096} required disabled={busy} onChange={event => setPassword(event.target.value)} />
                </div>
                <div className="browser-login-form-actions">
                  <button type="button" className="btn-secondary" disabled={busy} onClick={() => { setAdding(false); setUsername(''); setPassword('') }}>취소</button>
                  <button type="submit" className="btn-primary" disabled={busy || !password}>
                    {state?.accounts?.some(account => account.origin === origin && account.username === username) ? '비밀번호 업데이트' : '저장'}
                  </button>
                </div>
              </form>
            )}
            <input className="browser-login-search" type="search" value={query} placeholder="사이트 또는 아이디 검색" aria-label="저장된 계정 검색"
              onChange={event => { setQuery(event.target.value); setLimit(100) }} />
            {!!accounts.length && <ul className="browser-login-list">
              {accounts.slice(0, limit).map(account => (
                <li key={account.id}>
                  <span><strong>{account.username || '아이디 없음'}</strong><small>{account.origin}</small></span>
                  {account.origin === origin && <button type="button" className="btn-primary" disabled={busy}
                    onClick={() => void perform({ type: 'fill', id: account.id, origin })}>채우기</button>}
                  <button type="button" className="btn-secondary" disabled={busy} aria-label={`${account.origin} ${account.username} 로그인 삭제`}
                    onClick={() => void remove(account.id)}>삭제</button>
                </li>
              ))}
            </ul>}
            {state && accounts.length === 0 && <p className="browser-login-empty">{query ? '일치하는 계정이 없습니다.' : '저장된 계정이 없습니다.'}</p>}
            {accounts.length > limit && <button type="button" className="btn-secondary" onClick={() => setLimit(limit + 100)}>더 보기</button>}
          </section>
          {notice && <p className="browser-login-notice" role="status">{notice}</p>}
          {error && <p className="browser-login-error" role="alert">{error}</p>}
          <div className="modal-actions"><Dialog.Close className="btn-secondary" disabled={busy}>닫기</Dialog.Close></div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}
