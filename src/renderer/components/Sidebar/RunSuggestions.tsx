// What a failed run's logs suggest (stage 2: 실패 진단과 제안), opened from a preset's card: each finding in
// words, and for the two main can apply (a replacement for a blocked Maven repository; the project's
// settings.xml as the user settings) a button the user presses after reading. Nothing is applied by itself.
import { useEffect, useState } from 'react'
import * as Dialog from '@radix-ui/react-dialog'
import { RiAlertLine, RiStethoscopeLine } from 'react-icons/ri'
import {
  APPLIED_NOTE, cleanSuggestions, replacementUrl, suggestionTitle, USER_SETTINGS_WARNING, type RunSuggestion
} from '../../lib/runSuggestions'
import { reloadProjectPresets } from '../../stores/runPresetStore'
import { toast } from '../../stores/toastStore'
import './RunSuggestions.css'

export function RunSuggestionsDialog({ folder, presetId, presetName, onClose }: {
  /** The worktree the preset ran in */
  folder: string
  presetId: string
  presetName: string
  onClose: () => void
}) {
  // null while asked
  const [items, setItems] = useState<RunSuggestion[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    let active = true
    const ask = window.electronAPI.runPresetDiagnosis
    if (!ask) { setItems([]); return }
    ask(folder, presetId).then(result => {
      if (!active) return
      if (result?.ok === false) setError(result.error || '진단하지 못했습니다.')
      setItems(cleanSuggestions(result?.suggestions))
    }, () => { if (active) { setError('진단하지 못했습니다.'); setItems([]) } })
    return () => { active = false }
  }, [folder, presetId])

  const apply = async (item: RunSuggestion, url?: string) => {
    const send = window.electronAPI.runPresetApplySuggestion
    if (!send || busy) return
    setBusy(true)
    try {
      const result = await send(folder, presetId, { id: item.id, ...(url ? { replacementUrl: url } : {}) })
      if (result?.ok === false) {
        toast.error('제안을 적용하지 못했습니다', result.error)
        return
      }
      toast.success(APPLIED_NOTE)
      await reloadProjectPresets(folder)
      onClose()
    } catch {
      toast.error('제안을 적용하지 못했습니다')
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog.Root open onOpenChange={open => { if (!open && !busy) onClose() }}>
      <Dialog.Portal>
        <Dialog.Overlay className="modal-overlay" />
        <Dialog.Content className="modal-content run-suggestions-dialog" aria-describedby="run-suggestions-lead">
          <Dialog.Title className="modal-title"><RiStethoscopeLine size={18} aria-hidden="true" /> 실행 진단 · {presetName}</Dialog.Title>
          <p id="run-suggestions-lead" className="run-preset-hint">마지막 실행의 로그에서 찾은 것입니다. 적용은 내용을 보고 직접 눌러야 하며, 적용하면 다음 실행 때 한 번 더 확인합니다.</p>
          {error && <p className="run-preset-error" role="alert">{error}</p>}
          {items === null && <p className="run-preset-hint">진단하는 중…</p>}
          {items?.length === 0 && !error && <p className="run-suggestions-empty">로그에서 알려진 문제를 찾지 못했습니다.</p>}
          {items && items.length > 0 && (
            <ul className="run-suggestions">
              {items.map(item => <SuggestionItem key={item.id} item={item} busy={busy} onApply={apply} />)}
            </ul>
          )}
          <div className="modal-actions">
            <button type="button" className="btn-secondary modal-btn" onClick={onClose} disabled={busy}>닫기</button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}

function SuggestionItem({ item, busy, onApply }: { item: RunSuggestion; busy: boolean; onApply: (item: RunSuggestion, url?: string) => void }) {
  const [url, setUrl] = useState('')
  const [understood, setUnderstood] = useState(false)
  const checked = url ? replacementUrl(url) : null
  return (
    <li className="run-suggestion" data-kind={item.kind} data-apply={item.apply}>
      <strong className="run-suggestion-title">{suggestionTitle(item)}</strong>
      <p className="run-suggestion-message">{item.message}</p>
      {item.apply === 'mavenMirror' && (
        <div className="run-suggestion-apply">
          <label htmlFor={`run-suggestion-url-${item.id}`}>대신 쓸 저장소 주소</label>
          <input id={`run-suggestion-url-${item.id}`} value={url} placeholder="https://… 또는 file:///C:/maven-repo"
            onChange={event => setUrl(event.target.value)} spellCheck={false} autoComplete="off" />
          {checked && 'error' in checked && <small className="run-preset-warn">{checked.error}</small>}
          <small className="run-preset-hint">이 프로젝트 전용 Maven 설정에만 들어갑니다 (~/.m2/settings.xml 은 그대로).</small>
          <button type="button" className="btn-primary modal-btn" disabled={busy || !checked || 'error' in checked}
            onClick={() => { if (checked && 'url' in checked) onApply(item, checked.url) }}>이 주소로 대체</button>
        </div>
      )}
      {item.apply === 'mavenUserSettings' && (
        <div className="run-suggestion-apply">
          <div className="run-suggestion-warning" role="note">
            <RiAlertLine size={15} aria-hidden="true" />
            <span>{USER_SETTINGS_WARNING}</span>
          </div>
          <label className="run-suggestion-check">
            <input type="checkbox" checked={understood} onChange={event => setUnderstood(event.target.checked)} />
            <span>위 설정이 빠진다는 것을 확인했습니다</span>
          </label>
          <button type="button" className="btn-primary modal-btn" disabled={busy || !understood} onClick={() => onApply(item)}>
            프로젝트 설정으로 다시 실행하게 하기
          </button>
        </div>
      )}
    </li>
  )
}
