import type { RunPanelStatus } from '../stores/workspacePanelStore'
import { runPort, type RunPreset, type RunState } from './runPresets'

export const RUN_STATUS_LABELS = {
  unresponsive: '응답 없음', crashed: '비정상 종료', running: '실행 중',
  preparing: '준비 중', starting: '시작 중', idle: '대기', stopped: '중지됨'
} as const

export function runPanelStatus(state: RunState): keyof typeof RUN_STATUS_LABELS {
  return state.status === 'running' && state.unresponsive ? 'unresponsive' : state.status
}

export function runPanelPort(preset: RunPreset, state: RunState): string {
  return runPort(state.address) || (preset.port ? `:${preset.port}` : '')
}

export interface RunPanelRow {
  preset: RunPreset
  state: RunState
  step?: number
  repository?: string
  branch: string | null
  branchDiffers: boolean
  port: string
}

export interface RunPanelGroup {
  id: string
  label?: string
  step?: number
  ids: string[]
}

export function groupRunPanelRows(rows: RunPanelRow[], query: string, status: RunPanelStatus | null, bundleIds: Set<string> | null): RunPanelGroup[] {
  const matches = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean)
  const groups = new Map<string, RunPanelGroup>()
  const flat = matches.length > 0 || Boolean(status)
  const ordered = [...rows].sort((a, b) => {
    const byStage = (a.step ?? Infinity) - (b.step ?? Infinity)
    return byStage || (a.step === undefined ? (a.repository ?? '').localeCompare(b.repository ?? '') : 0)
      || a.preset.name.localeCompare(b.preset.name)
  })
  for (const row of ordered) {
    const { preset, state, repository, step, port } = row
    const kind = runPanelStatus(state)
    const problem = kind === 'crashed' || kind === 'unresponsive'
    const details = `${preset.name} ${preset.relative} ${port}`.toLocaleLowerCase()
    if ((status && status !== (status === 'running' ? state.status : kind)) || matches.some(part => !details.includes(part))) continue
    if (bundleIds && !bundleIds.has(preset.id) && !problem && state.status !== 'running' && !flat) continue
    const id = problem ? 'problems' : flat ? 'results' : step === undefined ? `repo:${repository ?? ''}` : `step:${step}`
    const existing = groups.get(id)
    if (existing) existing.ids.push(preset.id)
    else groups.set(id, {
      id, ids: [preset.id], step: !flat && !problem ? step : undefined,
      label: flat ? undefined : problem ? '문제' : step === undefined ? repository ?? '프로젝트' : `${step + 1}단계`
    })
  }
  const problems = groups.get('problems')
  groups.delete('problems')
  return [...(problems ? [problems] : []), ...groups.values()]
}
