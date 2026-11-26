// The run presets of a local project on its sidebar card (docs/plan/2026-11-25-local-project-run.md,
// mockups/dev-run-presets.html scenes 1·3·4·5·8): nothing when there are none (the worktree row has the add
// button), otherwise a head with 모두 실행 / 모두 중지 and a row per preset with its state and buttons.
import { useEffect, useState, type MouseEvent } from 'react'
import * as DropdownMenu from '@radix-ui/react-dropdown-menu'
import {
  RiAddLine, RiArrowDownLine, RiArrowUpLine, RiDeleteBinLine, RiEditLine, RiExternalLinkLine, RiFileList3Line, RiFlashlightLine,
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

export function requestAddRunPreset(folder: string) {
  window.dispatchEvent(new CustomEvent<string>(ADD_RUN_PRESET_EVENT, { detail: folder }))
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
  const hasApi = typeof runPresetApi().runPresetsList === 'function'

  const rootsKey = roots.join('|')
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { if (hasApi) void loadRunPresets(folder, roots) }, [folder, hasApi, rootsKey])
  useEffect(() => {
    const onAdd = (event: Event) => {
      if (pathKey((event as CustomEvent<string>).detail) === pathKey(folder)) setEditing('new')
    }
    window.addEventListener(ADD_RUN_PRESET_EVENT, onAdd)
    return () => window.removeEventListener(ADD_RUN_PRESET_EVENT, onAdd)
  }, [folder])

  const presets = project?.presets ?? []
  const states = project?.states ?? {}
  const ticking = presets.some(preset => {
    const state = states[preset.id]
    return state?.status === 'starting' || state?.status === 'preparing' || (!!state?.lastAction && state.lastAction.by !== 'user' && Date.now() - state.lastAction.at < AGENT_ACTION_MS)
      || reloadTicks(state, Date.now())
  })
  const now = useNow(ticking)
  if (!hasApi) return null
  // The place is held only while the list is on its way: a refused list shows nothing, as before
  const dialog = editing && <RunPresetDialog folder={folder} projectName={projectName} roots={roots}
    preset={editing === 'new' ? null : editing} onClose={() => setEditing(null)} />
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
          <span>{head.label}</span>
          {head.all === 'stop'
            ? <button type="button" onClick={() => void runPresetAction(folder, 'stopAll')}><RiStopFill size={11} aria-hidden="true" /> 모두 중지</button>
            : <button type="button" disabled={!head.canStartAll} onClick={() => void runPresetAction(folder, 'startAll')}
                title={head.canStartAll ? '모두 실행에 포함한 구성을 순서대로 띄웁니다' : '모두 실행에 포함한 구성이 없습니다'}>
                <RiPlayFill size={11} aria-hidden="true" /> 모두 실행
              </button>}
          <button type="button" className="run-presets-head-add" onClick={() => setEditing('new')} title="실행 구성 추가" aria-label="실행 구성 추가">
            <RiAddLine size={12} aria-hidden="true" />
          </button>
        </div>
        <ul className="run-presets-list">
          {presets.map((preset, index) => (
            <RunPresetRow key={preset.id} folder={folder} preset={preset} state={states[preset.id] ?? IDLE_STATE} now={now}
              first={index === 0} last={index === presets.length - 1} order={presets.map(item => item.id)}
              onEdit={() => setEditing(preset)} />
          ))}
        </ul>
      {dialog}
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

function RunPresetRow({ folder, preset, state, now, first, last, order, onEdit }: {
  folder: string; preset: RunPreset; state: RunState; now: number; first: boolean; last: boolean; order: string[]; onEdit: () => void
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
  const move = async (step: -1 | 1) => {
    const ids = [...order]
    const at = ids.indexOf(preset.id)
    ids.splice(at, 1)
    ids.splice(at + step, 0, preset.id)
    const result = await runPresetApi().runPresetsReorder?.(folder, ids).catch(() => undefined)
    if (!result || result.ok === false) toast.error('순서를 바꾸지 못했습니다', result?.error)
    void reloadProjectPresets(folder)
  }

  const crashed = state.status === 'crashed'
  return (
    <li className="run-preset" data-run-preset={preset.id} data-status={state.status} data-agent-acted={note ? 'true' : undefined}
      onClick={() => { if (state.shellId) void showLog() }}
      title={state.shellId ? `${preset.name} · 로그 보기` : preset.name} data-reload={state.reload && reload ? state.reload.status : undefined}>
      <div className="run-preset-main">
      <span className="run-preset-kind" data-kind={kind} aria-hidden="true"><KindIcon size={11} /></span>
      <span className="run-preset-name">{preset.name}</span>
      {note
        ? <span className="run-preset-note" role="status">{note}</span>
        : state.status === 'idle' || state.status === 'stopped'
          ? <span className="run-preset-folder">{runFolderLabel(preset.relative)}</span>
          // Nothing to show while running: a spacer that cancels its gap (the row is tight beside the state and four buttons)
          : <span className="run-preset-spacer" aria-hidden="true" />}
      {pills.length > 0 && (
        <span className="run-preset-state">
          {(state.status === 'starting' || state.status === 'preparing') && <span className="run-preset-spin" aria-hidden="true" />}
          {pills.map(pill => pill.errors
            // "오류 20" as a warning sign and the count: the row has no room for the word beside the port
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
            <DropdownMenu.Item className="terminal-menu-item" disabled={first} onSelect={() => void move(-1)}><RiArrowUpLine size={15} aria-hidden="true" /> 위로</DropdownMenu.Item>
            <DropdownMenu.Item className="terminal-menu-item" disabled={last} onSelect={() => void move(1)}><RiArrowDownLine size={15} aria-hidden="true" /> 아래로</DropdownMenu.Item>
            <DropdownMenu.Separator className="terminal-menu-separator" />
            <DropdownMenu.Item className="terminal-menu-item run-presets-danger" onSelect={() => void remove()}><RiDeleteBinLine size={15} aria-hidden="true" /> 삭제</DropdownMenu.Item>
          </DropdownMenu.Content>
        </DropdownMenu.Portal>
      </DropdownMenu.Root>
      </div>
      {/* The dialog is a portal, but its clicks still bubble through React to the row (which opens the log) */}
      {diagnosing && (
        <span hidden onClick={event => event.stopPropagation()}>
          <RunSuggestionsDialog folder={folder} presetId={preset.id} presetName={preset.name} proposals={proposals} onClose={() => setDiagnosing(false)} />
        </span>
      )}
      {/* Hot reload: its own line under the row while it is on (beside the state there is no room in the
          sidebar's width), kept from watching to the result so the row does not jump at each save */}
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
