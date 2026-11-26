import { useRef, useState, type DragEvent, type FormEvent } from 'react'
import * as Dialog from '@radix-ui/react-dialog'
import { RiArrowDownLine, RiArrowUpLine, RiDraggable } from 'react-icons/ri'
import type { RunPreset, RunStageGate, RunStartOrder } from '../../types'
import { moveOrderPreset, startOrderForSave, validWaitPart, type RunOrderTarget, type RunStartOrderDraft } from '../../lib/runStartOrderDraft'
import { reloadProjectPresets, runPresetApi } from '../../stores/runPresetStore'
import './RunStartOrder.css'

const GATES = {
  ready: '시작 완료',
  log: '로그에 문구가 나오면',
  url: '헬스 URL이 응답하면',
  none: '기다리지 않음'
} satisfies Record<RunStageGate['kind'], string>

type Target = RunOrderTarget
type DragItem = { preset: string } | { stage: number }

export function RunStartOrderDialog({ folder, projectName, presets, order, onClose }: {
  folder: string; projectName: string; presets: RunPreset[]; order: RunStartOrder; onClose: () => void
}) {
  const [draft, setDraft] = useState<RunStartOrderDraft>(() => ({
    ...order, stages: order.stages.map((stage, key) => ({ ...stage, key }))
  }))
  const nextStageKey = useRef(order.stages.length)
  const [minutes, setMinutes] = useState(() => String(Math.floor(order.timeoutSeconds / 60)))
  const [seconds, setSeconds] = useState(() => String(order.timeoutSeconds % 60))
  const [knownIds] = useState(() => presets.map(preset => preset.id))
  const [error, setError] = useState('')
  const [saving, setSaving] = useState(false)
  const [over, setOver] = useState<Target | null>(null)
  const dragged = useRef<DragItem | null>(null)
  const { stages } = draft
  const excluded = presets.filter(preset => !stages.some(stage => stage.ids.includes(preset.id)))
  const presetName = (id: string) => presets.find(preset => preset.id === id)?.name ?? id
  const set = (patch: Partial<RunStartOrderDraft>) => setDraft(current => ({ ...current, ...patch }))

  function movePreset(id: string, target: Target) {
    set({ stages: moveOrderPreset(stages, id, target, nextStageKey.current) })
    if (target === 'new') nextStageKey.current++
  }

  function moveStage(from: number, to: number) {
    if (from === to) return
    const next = [...stages]
    const [stage] = next.splice(from, 1)
    next.splice(to, 0, stage)
    set({ stages: next })
  }

  function changeGate(index: number, gate: RunStageGate) {
    set({ stages: stages.map((stage, at) => at === index ? { ...stage, gate } : stage) })
  }

  function beginDrag(event: DragEvent, item: DragItem) {
    event.stopPropagation()
    dragged.current = item
    event.dataTransfer.effectAllowed = 'move'
    event.dataTransfer.setData('application/x-ezshell-start-order', 'move')
  }

  function endDrag() {
    dragged.current = null
    setOver(null)
  }

  const dropProps = (target: Target) => ({
    'data-over': over === target || undefined,
    onDragOver(event: DragEvent) {
      if (!dragged.current || ('stage' in dragged.current && target === 'excluded')) return
      event.preventDefault()
      event.stopPropagation()
      event.dataTransfer.dropEffect = 'move'
      setOver(target)
    },
    onDrop(event: DragEvent) {
      const item = dragged.current
      if (!item || ('stage' in item && target === 'excluded')) return
      event.preventDefault()
      event.stopPropagation()
      if ('preset' in item) movePreset(item.preset, target)
      else moveStage(item.stage, target === 'new' ? stages.length - 1 : target as number)
      endDrag()
    }
  })

  function service(id: string, at: Target) {
    const name = presetName(id)
    return (
      <div key={id} className="run-order-service" draggable onDragStart={event => beginDrag(event, { preset: id })} onDragEnd={endDrag}>
        <RiDraggable aria-hidden="true" />
        <span title={name}>{name}</span>
        <select aria-label={`${name} 단계 이동`} value={at} onChange={event => {
          const value = event.target.value
          movePreset(id, value === 'new' || value === 'excluded' ? value : Number(value))
        }}>
          {stages.map((_, index) => <option key={index} value={index}>{index + 1}단계</option>)}
          <option value="new">새 단계</option>
          <option value="excluded">모두 실행에서 제외</option>
        </select>
      </div>
    )
  }

  async function save(event: FormEvent) {
    event.preventDefault()
    const value = startOrderForSave(draft, minutes, seconds)
    if (!value) {
      setError('기다리는 시간은 1초부터 60분까지 입력해 주세요.')
      return
    }
    setSaving(true)
    setError('')
    try {
      const result = await runPresetApi().runStartOrderSave?.(folder, value, knownIds)
      if (!result?.ok) {
        setError(result?.error ?? '기동 순서를 저장하지 못했습니다.')
        return
      }
      await reloadProjectPresets(folder)
      onClose()
    } catch { setError('기동 순서를 저장하지 못했습니다.') }
    finally { setSaving(false) }
  }

  return (
    <Dialog.Root open onOpenChange={open => { if (!open && !saving) onClose() }}>
      <Dialog.Portal>
        <Dialog.Overlay className="modal-overlay" />
        <Dialog.Content className="modal-content run-order-dialog">
          <Dialog.Title className="modal-title">기동 순서 · {projectName}</Dialog.Title>
          <Dialog.Description className="run-order-description">같은 단계에 둔 구성은 동시에 실행됩니다.</Dialog.Description>
          <form onSubmit={event => void save(event)}>
            <div className="run-order-body">
              {stages.map((stage, index) => (
                <section key={stage.key} className="run-order-stage" {...dropProps(index)}>
                  <header className="run-order-stage-head">
                    <span className="run-order-handle" draggable onDragStart={event => beginDrag(event, { stage: index })} onDragEnd={endDrag}><RiDraggable aria-hidden="true" /></span>
                    <strong>{index + 1}단계</strong>
                    {stage.ids.length > 1 && <small>동시에 {stage.ids.length}개</small>}
                    <button type="button" disabled={!index} aria-label={`${index + 1}단계 위로`} onClick={() => moveStage(index, index - 1)}><RiArrowUpLine /></button>
                    <button type="button" disabled={index === stages.length - 1} aria-label={`${index + 1}단계 아래로`} onClick={() => moveStage(index, index + 1)}><RiArrowDownLine /></button>
                    {index === stages.length - 1 ? <span className="run-order-last">마지막</span> : <label>다음 단계 기준
                      <select value={stage.gate.kind} onChange={event => {
                        const kind = event.target.value as RunStageGate['kind']
                        changeGate(index, kind === 'log' || kind === 'url' ? { kind, value: '' } : { kind })
                      }}>
                        {Object.entries(GATES).map(([kind, label]) => <option key={kind} value={kind}>{label}</option>)}
                      </select>
                    </label>}
                  </header>
                  {stage.ids.map(id => service(id, index))}
                  {index < stages.length - 1 && 'value' in stage.gate && <label className="run-order-value">{stage.gate.kind === 'log' ? '로그 문구' : '헬스 URL'}
                    <input value={stage.gate.value} required maxLength={stage.gate.kind === 'log' ? 200 : 2048}
                      placeholder={stage.gate.kind === 'log' ? 'Started Application' : 'http://127.0.0.1:8080/health'}
                      onChange={event => changeGate(index, { kind: stage.gate.kind as 'log' | 'url', value: event.target.value })} />
                  </label>}
                </section>
              ))}
              <div className="run-order-drop" {...dropProps('new')}>여기에 구성을 놓으면 새 단계</div>
              <section className="run-order-stage" {...dropProps('excluded')}>
                <strong>모두 실행에서 뺀 구성</strong>
                {excluded.length ? excluded.map(preset => service(preset.id, 'excluded')) : <small>없음</small>}
              </section>
              <section className="run-order-options">
                <div>
                  <div className="run-order-duration" role="group" aria-label="기다리는 시간">
                    <span>기다리는 시간</span>
                    <label>
                      <input type="number" min={0} max={60} value={minutes} aria-label="대기 시간 분"
                        onKeyDown={event => { if (event.key === '-') event.preventDefault() }}
                        onChange={event => { if (validWaitPart(event.target.value, 60)) setMinutes(event.target.value) }} /> 분
                    </label>
                    <label>
                      <input type="number" min={0} max={59} value={seconds} aria-label="대기 시간 초"
                        onKeyDown={event => { if (event.key === '-') event.preventDefault() }}
                        onChange={event => { if (validWaitPart(event.target.value, 59)) setSeconds(event.target.value) }} /> 초
                    </label>
                  </div>
                  <label>시간을 넘기면
                    <select value={draft.onTimeout} onChange={event => set({ onTimeout: event.target.value === 'continue' ? 'continue' : 'pause' })}>
                      <option value="pause">멈추고 알리기</option><option value="continue">계속</option>
                    </select>
                  </label>
                </div>
                <label><input type="checkbox" checked={draft.reverseStop} onChange={event => set({ reverseStop: event.target.checked })} /> 역순으로 중지</label>
                <label><input type="checkbox" checked={draft.askDependencies} onChange={event => set({ askDependencies: event.target.checked })} /> 하나만 실행할 때 앞 단계도 띄울지 묻기</label>
              </section>
            </div>
            {error && <p className="run-order-error" role="alert">{error}</p>}
            <div className="modal-actions">
              <button type="button" className="btn-secondary modal-btn" onClick={onClose} disabled={saving}>취소</button>
              <button type="submit" className="btn-primary modal-btn" disabled={saving}>저장</button>
            </div>
          </form>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}
