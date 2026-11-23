import { useEffect, useId, useRef, useState } from 'react'
import * as Dialog from '@radix-ui/react-dialog'
import { RiChromeLine, RiDownload2Line, RiEdgeLine } from 'react-icons/ri'
import { useBrowserBookmarkStore } from '../../stores/browserBookmarkStore'
import type { BrowserLoginSource } from '../../types'

const browserIcons = { chrome: RiChromeLine, edge: RiEdgeLine, firefox: null }
const readError = '브라우저 데이터를 가져올 수 없습니다. 다시 시도해 주세요.'

export function BrowserDataImportDialog({ tabId, trigger, onClose, onShowPasswords }: {
  tabId: string
  trigger: HTMLButtonElement | null
  onClose: () => void
  onShowPasswords: (profileId?: string) => void
}) {
  const [sources, setSources] = useState<BrowserLoginSource[] | null>(null)
  const [profileId, setProfileId] = useState('')
  const [bookmarks, setBookmarks] = useState(true)
  const [history, setHistory] = useState(true)
  const [running, setRunning] = useState(false)
  const [finished, setFinished] = useState(false)
  const [summary, setSummary] = useState('')
  const [error, setError] = useState('')
  const active = useRef(false)
  const handingOff = useRef(false)
  const id = useId()
  const selected = sources?.find(source => source.profiles.some(profile => profile.id === profileId))
  const importPages = useBrowserBookmarkStore(store => store.importPages)
  const api = window.electronAPI

  useEffect(() => {
    active.current = true
    void api.browserReviewImportData(tabId, { type: 'sources' }).then(result => {
      if (!active.current) return
      if (!result.success) { setSources([]); setError(result.error); return }
      const detected = result.sources ?? []
      setSources(detected)
      setProfileId(detected[0]?.profiles[0]?.id ?? '')
    }).catch(() => {
      if (!active.current) return
      setSources([])
      setError('설치된 브라우저 프로필을 확인할 수 없습니다.')
    })
    return () => { active.current = false }
  }, [api, tabId])

  async function startImport() {
    if (!selected || running || (!bookmarks && !history)) return
    setRunning(true)
    setError('')
    setSummary('')
    try {
      const result = await api.browserReviewImportData(tabId, { type: 'read', id: profileId, bookmarks, history })
      if (!active.current) return
      if (!result.success) { setError(result.error); return }
      const { bookmarks: saved, history: visits } = result
      const counts = importPages(saved && 'entries' in saved ? saved.entries : [], visits && 'entries' in visits ? visits.entries : [])
      const rows = []
      if (saved && 'entries' in saved) rows.push(`즐겨찾기 ${counts.bookmarks.added.toLocaleString()}개 추가`)
      if (visits && 'entries' in visits) rows.push(`방문 기록 ${counts.history.added.toLocaleString()}개 추가`)
      if (rows.length) {
        const limited = (saved && 'limited' in saved && saved.limited) || (visits && 'limited' in visits && visits.limited)
          || counts.bookmarks.limited || counts.history.limited
        setSummary(rows.join(' · ') + (limited ? ' · 저장 한도로 일부 항목을 건너뛰었습니다.' : ''))
      }
      const errors = [saved, visits].flatMap(category => category && 'error' in category ? [category.error] : [])
      if (!errors.length) setFinished(true)
      else setError(errors.join(' '))
    } catch {
      if (active.current) setError(readError)
    } finally {
      if (active.current) setRunning(false)
    }
  }

  return (
    <Dialog.Root open onOpenChange={open => { if (!open) { active.current = false; onClose() } }}>
      <Dialog.Portal>
        <Dialog.Overlay className="modal-overlay" />
        <Dialog.Content className="modal-content browser-login-dialog browser-data-import"
          onCloseAutoFocus={event => { event.preventDefault(); if (!handingOff.current) trigger?.focus({ preventScroll: true }) }}>
          <Dialog.Title className="modal-title"><RiDownload2Line size={20} />브라우저 데이터 가져오기</Dialog.Title>
          <Dialog.Description className="browser-data-description">Chrome과 Edge에서 즐겨찾기와 최근 방문 주소를 가져옵니다.</Dialog.Description>
          {!!sources?.length && !finished && <form className="browser-data-form" id={id} onSubmit={event => { event.preventDefault(); void startImport() }}>
            <fieldset className="browser-data-sources" disabled={running}>
              <legend>원본 브라우저</legend>
              {sources.map(source => {
                const Icon = browserIcons[source.id]
                return <label key={source.id}>
                  <input type="radio" name={`${id}-browser`} checked={selected?.id === source.id}
                    onChange={() => { setProfileId(source.profiles[0].id); setError(''); setSummary('') }} />
                  {Icon && <Icon aria-hidden="true" />}
                  <span>{source.name}</span>
                </label>
              })}
            </fieldset>
            {selected && <label className="browser-data-profile">프로필
              <select value={profileId} disabled={running || selected.profiles.length === 1}
                onChange={event => { setProfileId(event.target.value); setError(''); setSummary('') }}>
                {selected.profiles.map(profile => <option key={profile.id} value={profile.id}>{profile.name}</option>)}
              </select>
            </label>}
            <fieldset className="browser-data-options" disabled={running}>
              <legend>가져올 항목</legend>
              <label><input type="checkbox" checked={bookmarks} onChange={event => setBookmarks(event.target.checked)} />즐겨찾기</label>
              <label><input type="checkbox" checked={history} onChange={event => setHistory(event.target.checked)} />방문 기록</label>
            </fieldset>
          </form>}
          {sources === null && <p role="status">설치된 브라우저를 찾는 중…</p>}
          {sources?.length === 0 && !error && <p role="status">가져올 Chrome 또는 Edge 프로필이 없습니다.</p>}
          {running && <p role="status">{selected?.name} 프로필을 읽는 중…</p>}
          {summary && <p className="browser-data-result" role="status">{summary}</p>}
          {error && <p className="browser-login-error" role="alert">{error}</p>}
          <p className="browser-data-description">비밀번호는 브라우저에서 내보내야 합니다. 사이트 로그인은 ezShell에서 다시 진행해 주세요.</p>
          <div className="modal-actions browser-data-actions">
            <button type="button" className="btn-secondary" disabled={running} onClick={() => {
              handingOff.current = true
              active.current = false
              onShowPasswords(profileId || undefined)
            }}>비밀번호 가져오기</button>
            <Dialog.Close className="btn-secondary">{finished ? '완료' : '취소'}</Dialog.Close>
            {!finished && <button type="submit" form={id} className="btn-primary"
              disabled={!selected || running || (!bookmarks && !history)}>가져오기</button>}
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}
