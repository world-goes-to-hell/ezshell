// Makes or changes a run bundle (mockup scene 6′ note): a name and the presets to check. The order is not
// chosen here: a bundle starts its presets in the project's start order (기동 순서), so the list shows them in
// the card's order and says so.
import { useState, type FormEvent } from 'react'
import * as Dialog from '@radix-ui/react-dialog'
import { RiStackLine } from 'react-icons/ri'
import { bundleFromDraft, MAX_BUNDLE_NAME, orderedIds, type RunBundle } from '../../lib/runBundles'
import { runFolderLabel } from '../../lib/runPresets'
import { reloadProjectPresets, type WorktreeRuns } from '../../stores/runPresetStore'
import './RunBundles.css'

export function RunBundleDialog({ folder, runs, bundle, onClose, onSaved }: {
  folder: string
  runs: WorktreeRuns
  /** The bundle to change; null to make one */
  bundle: RunBundle | null
  onClose: () => void
  onSaved: (bundle: RunBundle) => void
}) {
  const [name, setName] = useState(bundle?.name ?? '')
  const [picked, setPicked] = useState<Set<string>>(() => new Set(bundle?.presetIds ?? []))
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const ordered = orderedIds(runs.presets, runs.startOrder)

  const toggle = (id: string) => setPicked(current => {
    const next = new Set(current)
    if (next.has(id)) next.delete(id)
    else next.add(id)
    return next
  })

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    const made = bundleFromDraft({ id: bundle?.id, name, presetIds: runs.presets.map(preset => preset.id).filter(id => picked.has(id)) }, runs.presets, runs.bundles)
    if ('error' in made) { setError(made.error); return }
    const save = window.electronAPI.runPresetBundleSave
    if (!save) return
    setSaving(true)
    setError(null)
    try {
      const result = await save(folder, made.bundle)
      if (result?.ok === false || !Array.isArray(result?.bundles)) { setError(result?.error || '묶음을 저장하지 못했습니다.'); return }
      await reloadProjectPresets(folder)
      const saved = result.bundles.find(item => (bundle ? item.id === bundle.id : item.name === made.bundle.name))
      if (saved) onSaved(saved)
      else onClose()
    } catch {
      setError('묶음을 저장하지 못했습니다.')
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog.Root open onOpenChange={open => { if (!open && !saving) onClose() }}>
      <Dialog.Portal>
        <Dialog.Overlay className="modal-overlay" />
        <Dialog.Content className="modal-content run-bundle-dialog" aria-describedby="run-bundle-order">
          <Dialog.Title className="modal-title"><RiStackLine size={18} aria-hidden="true" /> {bundle ? '실행 묶음 수정' : '실행 묶음 만들기'}</Dialog.Title>
          <form onSubmit={submit} className="run-bundle-form">
            <div className="form-group">
              <label htmlFor="run-bundle-name">이름</label>
              <input id="run-bundle-name" value={name} maxLength={MAX_BUNDLE_NAME} autoFocus placeholder="예: 주문 개발"
                onChange={event => setName(event.target.value)} spellCheck={false} autoComplete="off" />
            </div>
            <fieldset className="run-bundle-presets">
              <legend>띄울 실행 구성 <span className="run-preset-hint">({picked.size}개 고름)</span></legend>
              {runs.presets.length === 0 && <p className="run-preset-hint">실행 구성이 없습니다.</p>}
              {runs.presets.map(preset => {
                const outside = !ordered.has(preset.id)
                return (
                  <label key={preset.id} className="run-bundle-preset" data-on={picked.has(preset.id) || undefined}
                    title={outside ? '묶음에 넣으면 설정된 단계가 끝난 뒤 실행합니다.' : undefined}>
                    <input type="checkbox" checked={picked.has(preset.id)} onChange={() => toggle(preset.id)} />
                    <span className="run-bundle-preset-name">{preset.name}</span>
                    <span className="run-bundle-preset-folder">{outside ? '맨 뒤에서 실행' : runFolderLabel(preset.relative)}</span>
                  </label>
                )
              })}
            </fieldset>
            <small id="run-bundle-order" className="run-preset-hint">묶음은 프로젝트의 기동 순서를 따릅니다. 그 순서에 없는 구성은 맨 뒤에서 하나씩 실행합니다.</small>
            {error && <p className="run-preset-error" role="alert">{error}</p>}
            <div className="modal-actions">
              <button type="button" className="btn-secondary modal-btn" onClick={onClose} disabled={saving}>취소</button>
              <button type="submit" className="btn-primary modal-btn" disabled={saving}>{bundle ? '저장' : '만들기'}</button>
            </div>
          </form>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}
