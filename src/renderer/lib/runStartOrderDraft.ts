import type { RunStartOrder } from '../types'

export type RunOrderStageDraft = RunStartOrder['stages'][number] & { key: number }
export type RunStartOrderDraft = Omit<RunStartOrder, 'stages'> & { stages: RunOrderStageDraft[] }
export type RunOrderTarget = number | 'new' | 'excluded'

export function moveOrderPreset(stages: RunOrderStageDraft[], id: string, target: RunOrderTarget, newKey: number) {
  if (typeof target === 'number' && stages[target]?.ids.includes(id)) return stages
  const next = stages.map((stage, index) => ({
    ...stage,
    ids: index === target ? [...stage.ids, id] : stage.ids.filter(other => other !== id)
  })).filter(stage => stage.ids.length)
  if (target === 'new') next.push({ key: newKey, ids: [id], gate: { kind: 'none' } })
  return next
}

export function validWaitPart(value: string, max: number) {
  return /^\d*$/.test(value) && Number(value) <= max
}

export function startOrderForSave(draft: RunStartOrderDraft, minutes: string, seconds: string): RunStartOrder | null {
  const timeoutSeconds = Number(minutes) * 60 + Number(seconds)
  if (!validWaitPart(minutes, 60) || !validWaitPart(seconds, 59) || timeoutSeconds < 1 || timeoutSeconds > 3600) return null
  return {
    ...draft, timeoutSeconds,
    stages: draft.stages.map(({ ids, gate }, index) => ({ ids, gate: index < draft.stages.length - 1 ? gate : { kind: 'none' } }))
  }
}
