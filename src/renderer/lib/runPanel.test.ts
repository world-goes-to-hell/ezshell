import { describe, expect, it } from 'vitest'
import { groupRunPanelRows, runPanelPort, runPanelStatus, type RunPanelRow } from './runPanel'
import { IDLE_STATE, type RunPreset, type RunState } from './runPresets'

function row(name: string, state: Partial<RunState> = {}, options: Partial<RunPanelRow> = {}): RunPanelRow {
  const preset: RunPreset = {
    id: name, name, relative: `services/${name}`, kind: 'custom', jdk: 'system', env: {},
    notify: false, agentControl: false, inAll: true, waitReady: false
  }
  return { preset, state: { ...IDLE_STATE, ...state }, branch: null, branchDiffers: false, port: '', ...options }
}

describe('run panel', () => {
  const rows = [
    row('gateway', { status: 'running' }, { step: 1, port: ':8180' }),
    row('wallet', { status: 'crashed' }, { step: 2 }),
    row('payments', { status: 'running', unresponsive: { since: 1 } }, { step: 1, port: ':8181' }),
    row('infra', {}, { step: 0 }),
    row('legacy', {}, { repository: 'services/legacy' }),
    row('docs', {}, { repository: 'services/docs' })
  ]
  const compact = (groups: ReturnType<typeof groupRunPanelRows>) => groups.map(({ id, ids }) => [id, ids])

  it('puts problems above startup stages, then orders the remaining rows by repository', () => {
    expect(compact(groupRunPanelRows(rows, '', null, null))).toEqual([
      ['problems', ['payments', 'wallet']], ['step:0', ['infra']], ['step:1', ['gateway']],
      ['repo:services/docs', ['docs']], ['repo:services/legacy', ['legacy']]
    ])
  })

  it('filters on name, folder and reported port in a flat list', () => {
    expect(compact(groupRunPanelRows(rows, 'SERVICES 8180', null, null))).toEqual([['results', ['gateway']]])
    expect(compact(groupRunPanelRows(rows, 'APP', null, null))).toEqual([])
  })

  it('keeps running services and problems visible across bundles', () => {
    const bundle = new Set(['infra'])
    expect(compact(groupRunPanelRows(rows, '', null, bundle))).toEqual([
      ['problems', ['payments', 'wallet']], ['step:0', ['infra']], ['step:1', ['gateway']]
    ])
    expect(compact(groupRunPanelRows(rows, '', 'running', bundle))).toEqual([
      ['problems', ['payments']], ['results', ['gateway']]
    ])
    expect(compact(groupRunPanelRows(rows, '', 'unresponsive', null))).toEqual([['problems', ['payments']]])
  })

  it('prefers the active address port and clears the warning when a process stops', () => {
    const preset = { ...rows[0].preset, port: 8080 }
    expect(runPanelPort(preset, { ...IDLE_STATE, address: 'http://localhost:9000/' })).toBe(':9000')
    expect(runPanelPort(preset, IDLE_STATE)).toBe(':8080')
    expect(runPanelStatus({ ...IDLE_STATE, status: 'stopped', unresponsive: { since: 1 } })).toBe('stopped')
  })
})
