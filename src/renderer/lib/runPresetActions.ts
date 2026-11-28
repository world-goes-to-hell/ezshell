import type { IconType } from 'react-icons'
import {
  RiAddLine, RiCloseLine, RiDeleteBinLine, RiEditLine, RiExternalLinkLine, RiFileList3Line, RiFolderOpenLine, RiListOrdered2,
  RiPlayFill, RiRefreshLine, RiSendPlaneLine, RiSideBarLine, RiStackLine, RiStarFill, RiStarLine,
  RiStethoscopeLine, RiStopFill
} from 'react-icons/ri'
import { confirmDialog } from '../stores/confirmStore'
import { reloadProjectPresets, revealRunShell, runPresetAction, runPresetApi, type WorktreeRuns } from '../stores/runPresetStore'
import { toast } from '../stores/toastStore'
import { openRunPanel } from '../stores/workspacePanelStore'
import { bundleMembers, readBundleChoice, writeBundleChoice, type RunBundle } from './runBundles'
import { IDLE_STATE, isRunActive, runButtons, type RunPreset } from './runPresets'

export { openRunPanel } from '../stores/workspacePanelStore'

export interface RunActionItem {
  id: string
  label: string
  Icon: IconType
  enabled: boolean
  danger?: boolean
  run: () => void | Promise<unknown>
}

type Callback = RunActionItem['run']
const idle = () => {}

async function deletePreset(folder: string, preset: RunPreset) {
  const confirmed = await confirmDialog({
    title: '실행 구성 삭제', message: `${preset.name} 구성을 지웁니다.`, confirmLabel: '삭제', danger: true
  })
  if (!confirmed) return
  const result = await runPresetApi().runPresetsDelete?.(folder, preset.id).catch(() => undefined)
  if (!result || result.ok === false) toast.error('구성을 지우지 못했습니다', result?.error)
  await reloadProjectPresets(folder)
}

async function openPresetFolder(folder: string, relative: string) {
  const path = relative === '.' || !relative ? folder : `${folder.replace(/[\\/]$/, '')}/${relative}`
  const result = await runPresetApi().localProjectOpenFolder?.(path).catch(() => undefined)
  if (!result?.success) toast.error('폴더를 열지 못했습니다', result?.error)
}

async function openPresetAddress(folder: string, address: string) {
  try {
    const result = await runPresetApi().browserReviewOpenLink(address, 'internal', { folder })
    if (!result.success) toast.error('브라우저 열기', result.error)
  } catch {
    toast.error('브라우저를 열지 못했습니다')
  }
}

async function deleteBundle(runs: WorktreeRuns, bundle: RunBundle) {
  const confirmed = await confirmDialog({
    title: '묶음 삭제', message: `‘${bundle.name}’ 묶음을 지웁니다. 실행 구성은 그대로 남습니다.`,
    confirmLabel: '삭제', danger: true
  })
  if (!confirmed) return
  const result = await runPresetApi().runPresetBundleDelete?.(runs.folder, bundle.id).catch(() => undefined)
  if (!result || result.ok === false) { toast.error('묶음을 지우지 못했습니다', result?.error); return }
  if (readBundleChoice(runs.projectKey, runs.bundles)?.id === bundle.id) writeBundleChoice(runs.projectKey, null)
  await reloadProjectPresets(runs.folder)
}

export function runPresetActions({ runs, preset, pinned, onTogglePin, onEdit, onDiagnose, onSend }: {
  runs: WorktreeRuns
  preset: RunPreset
  pinned?: boolean
  onTogglePin?: Callback
  onEdit?: Callback
  onDiagnose?: Callback
  onSend?: Callback
}): RunActionItem[] {
  const { folder, states } = runs
  const state = states[preset.id] ?? IDLE_STATE
  const buttons = runButtons(state)
  const crashed = state.status === 'crashed'
  const { shellId, address } = state
  const api = runPresetApi()
  return [
    { id: 'start', label: '실행', Icon: RiPlayFill, enabled: buttons.includes('start'), run: () => runPresetAction(folder, 'start', preset.id) },
    { id: 'stop', label: '중지', Icon: RiStopFill, enabled: buttons.includes('stop'), run: () => runPresetAction(folder, 'stop', preset.id) },
    { id: 'restart', label: crashed ? '다시 실행' : '재기동', Icon: RiRefreshLine, enabled: buttons.includes('restart'), run: () => runPresetAction(folder, 'restart', preset.id) },
    { id: 'log', label: '로그 보기', Icon: RiFileList3Line, enabled: Boolean(shellId), run: () => { if (shellId) revealRunShell({ shellId, label: preset.name }) } },
    ...(address ? [{ id: 'open', label: '브라우저로 열기', Icon: RiExternalLinkLine, enabled: Boolean(api.browserReviewOpenLink),
      run: () => openPresetAddress(folder, address) }] : []),
    { id: 'diagnose', label: '실행 진단', Icon: RiStethoscopeLine, enabled: Boolean(onDiagnose && api.runPresetDiagnosis), run: onDiagnose ?? idle },
    ...(crashed ? [{ id: 'send', label: '에이전트에게 보내기', Icon: RiSendPlaneLine, enabled: Boolean(onSend && api.runPresetSendPreview), run: onSend ?? idle }] : []),
    { id: 'edit', label: '수정', Icon: RiEditLine, enabled: Boolean(onEdit), run: onEdit ?? idle },
    { id: 'pin', label: pinned ? '고정 풀기' : '늘 보이기', Icon: pinned ? RiStarFill : RiStarLine, enabled: Boolean(onTogglePin), run: onTogglePin ?? idle },
    { id: 'panel', label: '패널에서 보기', Icon: RiSideBarLine, enabled: true, run: () => openRunPanel(folder, { presetId: preset.id }) },
    { id: 'folder', label: '폴더 열기', Icon: RiFolderOpenLine, enabled: Boolean(api.localProjectOpenFolder), run: () => openPresetFolder(folder, preset.relative) },
    { id: 'delete', label: '삭제', Icon: RiDeleteBinLine, enabled: Boolean(api.runPresetsDelete) && !isRunActive(state), danger: true, run: () => deletePreset(folder, preset) }
  ]
}

export function runStageActions(runs: WorktreeRuns, ids: readonly string[]): RunActionItem[] {
  const active = ids.filter(id => isRunActive(runs.states[id] ?? IDLE_STATE)).length
  const scope = { presetIds: ids }
  return [
    { id: 'startStage', label: '이 단계만 실행', Icon: RiPlayFill, enabled: active < ids.length && (!runs.batch || runs.batch.status === 'cancelled'),
      run: () => runPresetAction(runs.folder, 'startAll', undefined, scope) },
    { id: 'stopStage', label: '이 단계 중지', Icon: RiStopFill, enabled: active > 0,
      run: () => runPresetAction(runs.folder, 'stopAll', undefined, scope) }
  ]
}

export function runProjectActions({ runs, bundle, onAdd, onOrder, onNewBundle, onEditBundle }: {
  runs: WorktreeRuns
  bundle?: RunBundle | null
  onAdd?: Callback
  onOrder?: Callback
  onNewBundle?: Callback
  onEditBundle?: Callback
}): RunActionItem[] {
  const { folder, presets, states, startOrder, batch } = runs
  const active = (preset: RunPreset) => isRunActive(states[preset.id] ?? IDLE_STATE)
  const running = presets.filter(preset => states[preset.id]?.status === 'running')
  const crashed = presets.filter(preset => states[preset.id]?.status === 'crashed')
  const members = bundle ? bundleMembers(presets, bundle, startOrder) : []
  const scope = bundle ? { bundleId: bundle.id } : undefined
  const canStart = !batch || batch.status === 'cancelled'
  const paused = batch?.status === 'paused' ? batch : null
  const failed = paused && presets.find(preset => paused.ids.includes(preset.id) && states[preset.id]?.shellId)
  const shellId = failed ? states[failed.id].shellId : undefined
  return [
    { id: 'startAll', label: '모두 실행', Icon: RiPlayFill, enabled: canStart && bundleMembers(presets, null, startOrder).some(preset => !active(preset)),
      run: () => runPresetAction(folder, 'startAll') },
    { id: 'stopAll', label: '모두 중지', Icon: RiStopFill, enabled: Boolean(batch && batch.status !== 'cancelled') || presets.some(active),
      run: () => runPresetAction(folder, 'stopAll') },
    { id: 'startBundle', label: bundle ? `${bundle.name} 실행` : '묶음 실행', Icon: RiPlayFill,
      enabled: canStart && members.some(preset => !active(preset)), run: () => runPresetAction(folder, 'startAll', undefined, scope) },
    { id: 'stopBundle', label: bundle ? `${bundle.name} 중지` : '묶음 중지', Icon: RiStopFill,
      enabled: members.some(active) || Boolean(batch && batch.status !== 'cancelled' && batch.stages.some(stage => members.some(preset => stage.includes(preset.id)))),
      run: () => runPresetAction(folder, 'stopAll', undefined, scope) },
    { id: 'newBundle', label: '묶음 만들기…', Icon: RiStackLine, enabled: Boolean(onNewBundle && presets.length), run: onNewBundle ?? idle },
    { id: 'editBundle', label: '묶음 수정…', Icon: RiEditLine, enabled: Boolean(bundle && onEditBundle), run: onEditBundle ?? idle },
    ...(bundle ? [{ id: 'deleteBundle', label: '묶음 삭제', Icon: RiDeleteBinLine, enabled: Boolean(runPresetApi().runPresetBundleDelete),
      danger: true, run: () => deleteBundle(runs, bundle) }] : []),
    { id: 'order', label: '기동 순서…', Icon: RiListOrdered2, enabled: Boolean(onOrder && startOrder && presets.length), run: onOrder ?? idle },
    { id: 'add', label: '실행 구성 추가', Icon: RiAddLine, enabled: Boolean(onAdd), run: onAdd ?? idle },
    { id: 'panel', label: '실행 패널 열기', Icon: RiSideBarLine, enabled: true, run: () => openRunPanel(folder) },
    { id: 'stopRunning', label: '실행 중 모두 중지', Icon: RiStopFill, enabled: running.length > 0,
      run: () => runPresetAction(folder, 'stopAll', undefined, { presetIds: running.map(preset => preset.id) }) },
    { id: 'restartCrashed', label: '종료한 것 모두 다시 실행', Icon: RiRefreshLine, enabled: canStart && crashed.length > 0,
      run: async () => {
        for (const preset of crashed) {
          if (!await runPresetAction(folder, 'restart', preset.id)) break
        }
      } },
    ...(paused ? [
      ...(shellId && failed ? [{ id: 'logOrder', label: '로그 보기', Icon: RiFileList3Line, enabled: true,
        run: () => revealRunShell({ shellId, label: failed.name }) }] : []),
      { id: 'skipOrder', label: '건너뛰고 계속', Icon: RiPlayFill, enabled: true, run: () => runPresetAction(folder, 'skipOrder') },
      { id: 'cancelOrder', label: '취소', Icon: RiCloseLine, enabled: true, run: () => runPresetAction(folder, 'cancelOrder') },
      { id: 'retryOrder', label: '다시 시도', Icon: RiRefreshLine, enabled: true, run: () => runPresetAction(folder, 'retryOrder') }
    ] : [])
  ]
}
