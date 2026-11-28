import type { RunPreset, RunState } from '../types'
import { runPanelStatus } from './runPanel'
import type { RunPanelStatus } from '../stores/workspacePanelStore'

export const isUnresponsiveRun = (state: RunState) => runPanelStatus(state) === 'unresponsive'

export function sidebarRunSummary(
  presets: readonly RunPreset[], states: Readonly<Record<string, RunState>>, pins: readonly string[]
) {
  const counts: Record<RunPanelStatus, number> = { running: 0, crashed: 0, unresponsive: 0 }
  const crashed: RunPreset[] = []
  const unresponsive: RunPreset[] = []
  const pinned: RunPreset[] = []

  for (const preset of presets) {
    const state = states[preset.id]
    const status = state && runPanelStatus(state)
    if (state?.status === 'running') counts.running++
    if (status === 'crashed') crashed.push(preset)
    else if (status === 'unresponsive') unresponsive.push(preset)
    else if (pins.includes(preset.id)) pinned.push(preset)
  }
  counts.crashed = crashed.length
  counts.unresponsive = unresponsive.length
  return { counts, visible: [...crashed, ...unresponsive, ...pinned] }
}
