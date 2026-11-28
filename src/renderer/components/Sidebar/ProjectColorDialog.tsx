import * as Dialog from '@radix-ui/react-dialog'
import { RiPaletteLine } from 'react-icons/ri'
import type { CSSProperties } from 'react'
import { useProjectColors } from '../../hooks/useProjectColors'
import {
  HARMONY_PALETTE, projectColor, writeProjectColors, type ProjectColorScheme, type ProjectColorSettings
} from '../../lib/localProjectColors'

// A local work card's colour (docs/plan/2026-11-27-local-project-colors.md): this project's own colour, and
// how the others are coloured. Every choice is saved and shown at once.

const SCHEMES: ReadonlyArray<{ value: ProjectColorScheme; label: string; detail: string }> = [
  { value: 'harmony', label: '조화로운 여러 색', detail: '어울리게 고른 10색을 작업 순서대로' },
  { value: 'analogous', label: '비슷한 계열', detail: '기준 색 둘레의 가까운 색들로' },
  { value: 'uniform', label: '모두 같은 색', detail: '모든 작업에 기준 색 하나' }
]

function HuePicker({ hue, label, onPick }: { hue: number; label: string; onPick: (hue: number) => void }) {
  return (
    <div className="project-color-picker">
      <div className="project-color-swatches" role="group" aria-label={label}>
        {HARMONY_PALETTE.map(entry => (
          <button key={entry.hue} type="button" className="project-color-swatch" title={entry.name} aria-label={entry.name}
            aria-pressed={entry.hue === hue} style={{ '--swatch': projectColor(entry.hue) } as CSSProperties}
            onClick={() => onPick(entry.hue)} />
        ))}
      </div>
      <input type="range" className="project-color-slider" min={0} max={359} step={1} value={hue} aria-label={`${label} 색상`}
        onChange={event => onPick(Number(event.target.value))} />
    </div>
  )
}

export function ProjectColorDialog({ projectKey, name, autoHue, onClose }: {
  projectKey: string
  name: string
  /** The hue this project gets without a colour of its own */
  autoHue: number
  onClose: () => void
}) {
  const settings = useProjectColors()
  const own = settings.manual[projectKey]
  const hue = own ?? autoHue
  const save = (next: ProjectColorSettings) => writeProjectColors(next)
  const pickOwn = (value: number) => save({ ...settings, manual: { ...settings.manual, [projectKey]: value } })
  const clearOwn = () => save({ ...settings, manual: Object.fromEntries(Object.entries(settings.manual).filter(([key]) => key !== projectKey)) })
  const pickedCount = Object.keys(settings.manual).length

  return (
    <Dialog.Root open onOpenChange={open => { if (!open) onClose() }}>
      <Dialog.Portal>
        <Dialog.Overlay className="modal-overlay" />
        {/* Focus waits for the user: the first swatch focused at open looked like the chosen colour */}
        <Dialog.Content className="modal-content project-color-dialog" aria-describedby={undefined}
          onOpenAutoFocus={event => event.preventDefault()}>
          <Dialog.Title className="modal-title">
            <RiPaletteLine size={18} aria-hidden="true" /> 색상
            <span className="project-color-preview" style={{ '--swatch': projectColor(hue) } as CSSProperties}>{name}</span>
          </Dialog.Title>

          <section className="project-color-section" aria-label="이 작업">
            <div className="project-color-heading">
              <h3>이 작업</h3>
              <span className="project-color-state">{own === undefined ? '자동' : '직접 고른 색'}</span>
            </div>
            <HuePicker hue={hue} label="이 작업" onPick={pickOwn} />
            <button type="button" className="btn-secondary modal-btn project-color-auto" disabled={own === undefined} onClick={clearOwn}>자동으로</button>
          </section>

          <section className="project-color-section" aria-label="모든 작업">
            <h3>모든 작업</h3>
            <div className="project-color-schemes" role="radiogroup" aria-label="자동 색 방식">
              {SCHEMES.map(scheme => (
                <label key={scheme.value} className="project-color-scheme" data-scheme={scheme.value}>
                  <input type="radio" name="project-color-scheme" checked={settings.scheme === scheme.value}
                    onChange={() => save({ ...settings, scheme: scheme.value })} />
                  <span><strong>{scheme.label}</strong><small>{scheme.detail}</small></span>
                </label>
              ))}
            </div>
            {settings.scheme !== 'harmony' && (
              <div className="project-color-base">
                <span>기준 색</span>
                <HuePicker hue={settings.baseHue} label="기준" onPick={value => save({ ...settings, baseHue: value })} />
              </div>
            )}
            <button type="button" className="btn-secondary modal-btn" disabled={pickedCount === 0}
              onClick={() => save({ ...settings, manual: {} })}>직접 고른 색 모두 지우기{pickedCount ? ` (${pickedCount})` : ''}</button>
          </section>

          <div className="modal-actions">
            <Dialog.Close type="button" className="btn-primary modal-btn">닫기</Dialog.Close>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}
