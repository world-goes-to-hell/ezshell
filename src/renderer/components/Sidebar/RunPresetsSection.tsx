// The run presets of a local project on its sidebar card (docs/plan/2026-11-25-local-project-run.md,
// mockups/dev-run-presets.html scenes 1·3·4·5·8): nothing when there are none (the worktree row has the add
// button), otherwise a head with 모두 실행 / 모두 중지 and a row per preset with its state and buttons.
import { useEffect, useState, type MouseEvent } from 'react'
import * as DropdownMenu from '@radix-ui/react-dropdown-menu'
import {
  RiAddLine, RiDeleteBinLine, RiEditLine, RiExternalLinkLine, RiFileList3Line, RiFlashlightLine,
  RiLightbulbLine, RiMoreFill, RiPlayFill, RiRefreshLine, RiStethoscopeLine, RiStopFill, RiTerminalLine, RiErrorWarningFill
} from 'react-icons/ri'
import { SiApachetomcat, SiNodedotjs, SiSpringboot, SiVite, SiVuedotjs } from 'react-icons/si'
import { FaJava } from 'react-icons/fa'
import {
  agentActionNote, AGENT_ACTION_MS, IDLE_STATE, reloadChip, reloadTicks, runButtons, runFolderLabel, runHead, runKind, runPills,
  type RunButton, type RunPreset, type RunState
} from '../../lib/runPresets'
import {
  fetchRunErrors, knownPresetCount, loadRunPresets, reloadProjectPresets, revealRunShell, runPresetAction, runPresetApi, selectWorktree,
  useRunPresets
} from '../../stores/runPresetStore'
import { confirmDialog } from '../../stores/confirmStore'
import { pathKey } from '../../lib/localWorkspaceTree'
import { toast } from '../../stores/toastStore'
import { RunPresetDialog } from './RunPresetDialog'
import { NestedRepositoryRunChips } from './NestedRepositories'
import { RunStartOrderDialog } from './RunStartOrderDialog'
import { RunBundlePicker } from './RunBundlePicker'
import type { RunStartProgress } from '../../types'
import { RunSuggestionsDialog } from './RunSuggestions'
import { cleanProposals, proposalSummary } from '../../lib/runSuggestions'
import './RunPresets.css'

const KIND_ICONS = { spring: SiSpringboot, vue: SiVuedotjs, vite: SiVite, node: SiNodedotjs, java: FaJava, tomcat: SiApachetomcat, custom: RiTerminalLine }

const BUTTONS: Record<RunButton, { label: string; Icon: typeof RiPlayFill }> = {
  start: { label: '실행', Icon: RiPlayFill },
  restart: { label: '재기동', Icon: RiRefreshLine },
  stop: { label: '중지', Icon: RiStopFill },
  open: { label: '브라우저로 열기', Icon: RiExternalLinkLine },
  log: { label: '로그 보기', Icon: RiFileList3Line }
}

/** Seconds tick only while a row shows a count (starting, an agent's recent action) */
function useNow(ticking: boolean) {
  const [now, setNow] = useState(Date.now)
  useEffect(() => {
    if (!ticking) return
    setNow(Date.now())
    const timer = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [ticking])
  return now
}

// A worktree without presets keeps no place on the card (user's request, 2026-11-26): the add is a small
// button on the worktree row (RunPresetAddButton) and an item of its right-click menu, both through this event
const ADD_RUN_PRESET_EVENT = 'ezshell:add-run-preset'

/** What the dialog starts from when the worktree menu's found start command opened it (it starts the run once added) */
export interface RunPresetSeed { relative: string; taskId?: string }

export function requestAddRunPreset(folder: string, seed?: RunPresetSeed) {
  window.dispatchEvent(new CustomEvent<{ folder: string; seed?: RunPresetSeed }>(ADD_RUN_PRESET_EVENT, { detail: { folder, seed } }))
}

/** The worktree row's add button: only while its list came and is empty (with presets, the head has its own) */
export function RunPresetAddButton({ folder }: { folder: string }) {
  const empty = useRunPresets(state => selectWorktree(state, folder)?.presets.length === 0)
  if (!empty || typeof runPresetApi().runPresetsList !== 'function') return null
  return (
    // data-run-worktree: like the section, it marks a worktree whose list came
    <button type="button" className="run-presets-row-add" data-run-worktree={folder} onClick={() => requestAddRunPreset(folder)}
      title="실행 구성 추가 (백엔드·프론트엔드)" aria-label="실행 구성 추가">
      <RiAddLine size={14} aria-hidden="true" />
    </button>
  )
}

/** The run presets of a project as one worktree runs them (`folder` is the worktree's) */
export function RunPresetsSection({ folder, projectName, roots }: { folder: string; projectName: string; roots: string[] }) {
  const project = useRunPresets(state => selectWorktree(state, folder))
  const failed = useRunPresets(state => !!state.failed[pathKey(folder)])
  const [editing, setEditing] = useState<RunPreset | 'new' | null>(null)
  const [ordering, setOrdering] = useState(false)
  const [seed, setSeed] = useState<RunPresetSeed | undefined>(undefined)
  const hasApi = typeof runPresetApi().runPresetsList === 'function'

  const rootsKey = roots.join('|')
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { if (hasApi) void loadRunPresets(folder, roots) }, [folder, hasApi, rootsKey])
  useEffect(() => {
    const onAdd = (event: Event) => {
      const detail = (event as CustomEvent<{ folder: string; seed?: RunPresetSeed }>).detail
      if (pathKey(detail.folder) !== pathKey(folder)) return
      setSeed(detail.seed)
      setEditing('new')
    }
    window.addEventListener(ADD_RUN_PRESET_EVENT, onAdd)
    return () => window.removeEventListener(ADD_RUN_PRESET_EVENT, onAdd)
  }, [folder])

  const presets = project?.presets ?? []
  const states = project?.states ?? {}
  const progress = project?.batch
  const batch = progress?.status === 'cancelled' ? null : progress
  const ticking = batch?.status === 'waiting' || presets.some(preset => {
    const state = states[preset.id]
    return state?.status === 'starting' || state?.status === 'preparing' || (!!state?.lastAction && state.lastAction.by !== 'user' && Date.now() - state.lastAction.at < AGENT_ACTION_MS)
      || reloadTicks(state, Date.now())
  })
  const now = useNow(ticking)
  if (!hasApi) return null
  // The place is held only while the list is on its way: a refused list shows nothing, as before
  const dialog = editing && <RunPresetDialog folder={folder} projectName={projectName} roots={roots}
    preset={editing === 'new' ? null : editing} seed={editing === 'new' ? seed : undefined}
    onClose={() => { setEditing(null); setSeed(undefined) }} />
  if (!project) {
    const count = knownPresetCount(folder)
    return failed ? dialog || null : count > 0 ? <RunPresetsPlaceholder count={count} /> : dialog || null
  }
  // None yet: nothing on the card, only the dialog when the row's add button opened it
  if (presets.length === 0) return dialog || null
  const head = runHead(presets, states)

  return (
    <div className="run-presets" data-run-worktree={folder}>
        <div className="run-presets-head">
          <span>{batch ? `실행 · ${batch.index + 1}/${batch.total}단계` : head.label}</span>
          {batch
            ? <button type="button" onClick={() => void runPresetAction(folder, 'stopAll')}><RiStopFill size={11} aria-hidden="true" /> 모두 중지</button>
            : <RunBundlePicker folder={folder} runs={project} />}
          <button type="button" className="run-presets-head-add" onClick={() => { setSeed(undefined); setEditing('new') }} title="실행 구성 추가" aria-label="실행 구성 추가">
            <RiAddLine size={12} aria-hidden="true" />
          </button>
          {project.startOrder && <DropdownMenu.Root modal={false}>
            <DropdownMenu.Trigger asChild>
              <button type="button" className="run-presets-head-add" aria-label="실행 구성 메뉴" title="실행 구성 메뉴"><RiMoreFill size={13} /></button>
            </DropdownMenu.Trigger>
            <DropdownMenu.Portal>
              <DropdownMenu.Content className="terminal-menu sidebar-popover" align="end" sideOffset={4}>
                <DropdownMenu.Item className="terminal-menu-item" onSelect={() => setOrdering(true)}>기동 순서…</DropdownMenu.Item>
              </DropdownMenu.Content>
            </DropdownMenu.Portal>
          </DropdownMenu.Root>}
        </div>
        {batch && <progress className="run-start-progress" aria-label="기동 순서 진행" max={batch.total} value={batch.index + 1} />}
        {(progress?.status === 'paused' || progress?.status === 'cancelled') &&
          <StartOrderRecovery folder={folder} batch={progress} presets={presets} states={states} />}
        <ul className="run-presets-list">
          {presets.map(preset => (
            <RunPresetRow key={preset.id} folder={folder} preset={preset} state={states[preset.id] ?? IDLE_STATE} now={now}
              step={batch?.stages.findIndex(ids => ids.includes(preset.id))} batch={batch}
              onEdit={() => setEditing(preset)} />
          ))}
        </ul>
      {dialog}
      {ordering && project.startOrder && <RunStartOrderDialog folder={folder} projectName={projectName} presets={presets}
        order={project.startOrder} onClose={() => setOrdering(false)} />}
    </div>
  )
}

/**
 * The place of the card's presets while they load: the head and as many rows as last time, so the rows
 * below do not move when the list comes (a card that had none holds no place, as it shows none)
 */
function RunPresetsPlaceholder({ count }: { count: number }) {
  return (
    <div className="run-presets run-presets-placeholder" aria-hidden="true">
      <div className="run-presets-skeleton" data-kind="head" />
      <div className="run-presets-list">
        {Array.from({ length: count }, (_, index) => <div key={index} className="run-presets-skeleton" data-kind="row" />)}
      </div>
    </div>
  )
}

function StartOrderRecovery({ folder, batch, presets, states }: {
  folder: string; batch: Extract<RunStartProgress, { status: 'paused' | 'cancelled' }>; presets: RunPreset[]; states: Record<string, RunState>
}) {
  const affected = batch.status === 'paused' ? presets.filter(preset => batch.ids.includes(preset.id)) : []
  const log = affected.find(preset => states[preset.id]?.shellId)
  const reason = { timeout: '기다리는 시간을 넘겼습니다.', exited: '실행 구성이 비정상 종료됐습니다.',
    startFailed: '실행하지 못했습니다.', cancelled: '기동 순서가 취소됐습니다.' }[batch.reason]
  const details = [`${batch.index + 1}단계`, affected.map(preset => preset.name).join(', '), reason].filter(Boolean).join(' · ')
  return <div className="run-start-recovery">
    <div className="run-start-recovery-summary" role="status" title={batch.status === 'paused' ? batch.error : undefined}>
      <RiErrorWarningFill size={13} aria-hidden="true" />
      <span>{details}</span>
    </div>
    <div className="run-start-recovery-actions">
      {batch.status === 'paused' ? <>
        {log && <button className="btn-secondary" type="button" onClick={() => revealRunShell({ shellId: states[log.id].shellId!, label: log.name })}>로그 보기</button>}
        <button className="btn-secondary" type="button" onClick={() => void runPresetAction(folder, 'skipOrder')}>건너뛰고 계속</button>
        <button className="btn-secondary" type="button" title="실행 중인 서비스는 유지합니다" onClick={() => void runPresetAction(folder, 'cancelOrder')}>취소</button>
        <button className="btn-primary" type="button" onClick={() => void runPresetAction(folder, 'retryOrder')}>다시 시도</button>
      </> : <button className="btn-secondary" type="button" onClick={() => void runPresetAction(folder, 'cancelOrder')}>닫기</button>}
    </div>
  </div>
}

function RunPresetRow({ folder, preset, state, now, step, batch, onEdit }: {
  folder: string; preset: RunPreset; state: RunState; now: number; step?: number; batch?: RunStartProgress | null; onEdit: () => void
}) {
  const kind = runKind(preset)
  const KindIcon = KIND_ICONS[kind]
  const pills = runPills(state, now)
  const buttons = runButtons(state)
  const note = agentActionNote(state.lastAction, now)
  const [diagnosing, setDiagnosing] = useState(false)
  const reload = reloadChip(state, now)
  // Agents' proposals waiting for the user (newest first): a line under the row, reviewed in the diagnosis
  const proposals = cleanProposals(state.proposals)

  const showLog = async (toFirstError = false) => {
    if (!state.shellId) return
    let errorLine: string | undefined
    if (toFirstError) errorLine = (await fetchRunErrors(folder, preset.id))[0]?.lines.find(line => line.trim())
    revealRunShell({ shellId: state.shellId, label: preset.name, errorLine })
  }
  const open = async () => {
    if (!state.address) return
    try {
      const result = await window.electronAPI.browserReviewOpenLink(state.address, 'internal', { folder })
      if (!result.success) toast.error('브라우저 열기', result.error)
    } catch { toast.error('브라우저를 열지 못했습니다') }
  }
  const press = (button: RunButton) => (event: MouseEvent) => {
    event.stopPropagation()
    if (button === 'log') void showLog()
    else if (button === 'open') void open()
    else void runPresetAction(folder, button, preset.id)
  }
  const remove = async () => {
    const yes = await confirmDialog({ title: '실행 구성 삭제', message: `${preset.name} 구성을 지웁니다. 실행 중이면 먼저 중지해 주세요.`, confirmLabel: '삭제', danger: true })
    if (!yes) return
    const result = await runPresetApi().runPresetsDelete?.(folder, preset.id).catch(() => undefined)
    if (!result || result.ok === false) toast.error('구성을 지우지 못했습니다', result?.error)
    void reloadProjectPresets(folder)
  }
  const waiting = batch?.status === 'waiting' && batch.ids.includes(preset.id) ? batch : null
  const seconds = waiting ? Math.max(0, Math.floor((now - waiting.since) / 1000)) : 0
  const waitingText = waiting && `${{ ready: '시작 완료', log: '문구', url: '헬스 URL', none: '' }[waiting.gate.kind]} 기다림 ${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`
  const queued = batch && step !== undefined && step > batch.index

  const crashed = state.status === 'crashed'
  const failureReason = crashed ? state.failureReason : undefined
  return (
    <li className="run-preset" data-run-preset={preset.id} data-status={state.status} data-agent-acted={note ? 'true' : undefined}
      onClick={() => { if (state.shellId) void showLog() }}
      title={state.shellId ? `${preset.name} · 로그 보기` : preset.name} data-reload={state.reload && reload ? state.reload.status : undefined}>
      <div className="run-preset-main">
        <span className="run-preset-kind" data-kind={kind} aria-hidden="true"><KindIcon size={11} /></span>
        <span className="run-preset-name">{preset.name}</span>
        {buttons.map(button => {
          const { label, Icon } = BUTTONS[button]
          const shown = crashed && button === 'restart' ? '다시 실행' : label
          return (
            <button key={button} type="button" className="run-preset-btn" data-action={button} onClick={press(button)}
              data-emphasis={button === 'restart' && reload?.restart ? 'true' : undefined}
              title={button === 'restart' && reload?.restart ? `${shown} · 바뀐 내용을 적용하려면 재기동이 필요합니다` : shown} aria-label={`${preset.name} ${shown}`}>
              <Icon size={13} aria-hidden="true" />
            </button>
          )
        })}
        <DropdownMenu.Root modal={false}>
          <DropdownMenu.Trigger asChild>
            <button type="button" className="run-preset-btn" title="더 보기" aria-label={`${preset.name} 더 보기`} onClick={event => event.stopPropagation()}>
              <RiMoreFill size={13} aria-hidden="true" />
            </button>
          </DropdownMenu.Trigger>
          <DropdownMenu.Portal>
            {/* A portal too: a picked item's click must not reach the row (which opens the log) */}
            <DropdownMenu.Content className="terminal-menu sidebar-popover" side="bottom" align="end" sideOffset={4} collisionPadding={8}
              onClick={event => event.stopPropagation()}>
              <DropdownMenu.Item className="terminal-menu-item" onSelect={onEdit}><RiEditLine size={15} aria-hidden="true" /> 수정</DropdownMenu.Item>
              {typeof window.electronAPI.runPresetDiagnosis === 'function' && (
                <DropdownMenu.Item className="terminal-menu-item" onSelect={() => setDiagnosing(true)}>
                  <RiStethoscopeLine size={15} aria-hidden="true" /> 실행 진단
                </DropdownMenu.Item>
              )}
              <DropdownMenu.Separator className="terminal-menu-separator" />
              <DropdownMenu.Item className="terminal-menu-item run-presets-danger" onSelect={() => void remove()}><RiDeleteBinLine size={15} aria-hidden="true" /> 삭제</DropdownMenu.Item>
            </DropdownMenu.Content>
          </DropdownMenu.Portal>
        </DropdownMenu.Root>
      </div>
      <div className="run-preset-details">
        {step !== undefined && step >= 0 && <span className="run-start-step" aria-label={`${step + 1}단계`}>{step + 1}</span>}
        <NestedRepositoryRunChips root={folder} relative={preset.relative} runningSince={state.status === 'running' && (!preset.hotReload || preset.hotReload === 'off') ? state.startedAt : undefined} />
        {note
          ? <span className="run-preset-note" role="status">{note}</span>
          : (state.status === 'idle' || state.status === 'stopped') && <span className="run-preset-folder">{runFolderLabel(preset.relative)}</span>}
        {pills.length > 0 && (
          <span className="run-preset-state">
            {(state.status === 'starting' || state.status === 'preparing') && <span className="run-preset-spin" aria-hidden="true" />}
            {pills.map(pill => pill.errors
              ? <button key={pill.text} type="button" className="run-preset-pill is-count" data-kind={pill.kind} aria-label={pill.text}
                  onClick={event => { event.stopPropagation(); void showLog(true) }} title={`${pill.text} · 첫 오류 줄로 가기`}>
                  <RiErrorWarningFill size={10} aria-hidden="true" />{pill.text.replace(/^\D+/, '')}
                </button>
              : pill.kind === 'port' && state.address
                ? <button key={pill.text} type="button" className="run-preset-pill" data-kind={pill.kind} aria-label={`${preset.name} 브라우저로 열기 ${pill.text}`}
                    onClick={press('open')} title={`브라우저로 열기 · ${state.address}`}>{pill.text}</button>
                : <span key={pill.text} className="run-preset-pill" data-kind={pill.kind}>{pill.text}</span>)}
          </span>
        )}
      </div>
      {failureReason && (typeof window.electronAPI.runPresetDiagnosis === 'function'
        ? <button type="button" className="run-preset-failure-line" title={failureReason}
            aria-label={`${failureReason} 실행 진단 보기`}
            onClick={event => { event.stopPropagation(); setDiagnosing(true) }}>
            <RiErrorWarningFill size={11} aria-hidden="true" />
            <span>{failureReason}</span>
          </button>
        : <div className="run-preset-failure-line" title={failureReason}>
            <RiErrorWarningFill size={11} aria-hidden="true" />
            <span>{failureReason}</span>
          </div>)}
      {(waitingText || queued) && <div className="run-start-wait" data-wait={waiting?.gate.kind ?? 'queued'}
        title={waiting && 'value' in waiting.gate ? waiting.gate.value : undefined}>{waitingText || '앞 단계 대기'}</div>}
      {/* The dialog is a portal, but its clicks still bubble through React to the row (which opens the log) */}
      {diagnosing && (
        <span hidden onClick={event => event.stopPropagation()}>
          <RunSuggestionsDialog folder={folder} presetId={preset.id} presetName={preset.name} proposals={proposals} onClose={() => setDiagnosing(false)} />
        </span>
      )}
      {/* Keep the hot reload line from watching to the result so the row does not jump at each save. */}
      {reload && (
        <div className="run-preset-reload-line">
          <RiFlashlightLine size={10} aria-hidden="true" />
          {reload.toErrors
            ? <button type="button" className="run-preset-reload-chip" data-tone={reload.tone}
                onClick={event => { event.stopPropagation(); void showLog(true) }} title={reload.title}>{reload.text}</button>
            : <span className="run-preset-reload-chip" data-tone={reload.tone} title={reload.title}>{reload.text}</span>}
        </div>
      )}
      {proposals.length > 0 && (
        <div className="run-preset-proposal-line" data-proposals={proposals.length}>
          <RiLightbulbLine size={11} aria-hidden="true" />
          <span className="run-preset-proposal-text" title={[`${proposals[0].by}: ${proposalSummary(proposals[0])}`, proposals[0].note].filter(Boolean).join(' — ')}>
            <strong>{proposals[0].by}</strong> 제안 · {proposalSummary(proposals[0])}{proposals.length > 1 ? ` 외 ${proposals.length - 1}개` : ''}
          </span>
          <button type="button" className="run-preset-proposal-btn" title="진단 창에서 제안을 보고 직접 적용하거나 버립니다"
            onClick={event => { event.stopPropagation(); setDiagnosing(true) }}>보기</button>
        </div>
      )}
    </li>
  )
}
