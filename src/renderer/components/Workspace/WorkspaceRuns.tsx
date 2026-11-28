import { useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import * as DropdownMenu from '@radix-ui/react-dropdown-menu'
import { RiCloseLine, RiMoreFill, RiSearchLine, RiStarFill } from 'react-icons/ri'
import { useLocalProjects } from '../../hooks/useLocalProjects'
import { folderLabel, pathKey, worktreeOf } from '../../lib/localWorkspaceTree'
import { readBundleChoice, writeBundleChoice, type RunBundle } from '../../lib/runBundles'
import { openRunPanel, runPresetActions, runProjectActions, runStageActions, type RunActionItem } from '../../lib/runPresetActions'
import { groupRunPanelRows, runPanelPort, runPanelStatus, RUN_STATUS_LABELS, type RunPanelGroup, type RunPanelRow } from '../../lib/runPanel'
import { IDLE_STATE, type RunPreset } from '../../lib/runPresets'
import { cleanProposals } from '../../lib/runSuggestions'
import { refreshNestedRepositoryProject, repositoryForPreset, useNestedRepositories } from '../../stores/nestedRepositoryStore'
import { loadRunPresets, runPresetApi, selectWorktree, useRunPresets, type WorktreeRuns } from '../../stores/runPresetStore'
import { toggleRunPresetPin, useRunSummary } from '../../stores/runSummaryStore'
import { useWorkspacePanelStore, type RunPanelStatus, type RunPanelTarget } from '../../stores/workspacePanelStore'
import { buildProjectNodes } from '../Sidebar/LocalProjectsTree'
import { RunBundleDialog } from '../Sidebar/RunBundleDialog'
import { RunSendDialog } from '../Sidebar/RunCrashNotices'
import { RunPresetDialog } from '../Sidebar/RunPresetDialog'
import { RunStartOrderDialog } from '../Sidebar/RunStartOrderDialog'
import { RunSuggestionsDialog } from '../Sidebar/RunSuggestions'
import { WorkspaceNote } from './WorkspaceBrowser'
import './WorkspaceRuns.css'

const STATUS_FILTERS: readonly RunPanelStatus[] = ['running', 'crashed', 'unresponsive']
const STATUS_MARKS = { running: '●', crashed: '⚠', unresponsive: '◐' }
const NO_ROOTS: string[] = []
const NO_PINS: string[] = []
const NO_STAGES: string[][] = []
const RECOVERY_ACTIONS = new Set(['logOrder', 'skipOrder', 'cancelOrder', 'retryOrder'])

export function WorkspaceRuns({ folder }: { folder: string | null }) {
  const { projects } = useLocalProjects()
  const nodes = useMemo(() => buildProjectNodes(projects), [projects])
  const target = useWorkspacePanelStore(state => state.runTarget)
  const worktrees = nodes.flatMap(node => node.worktrees.map(tree => ({ ...tree, node })))
  const current = folder && worktreeOf(folder, worktrees.map(tree => tree.path))
  const choice = target?.folder ?? current ?? ''
  const tree = worktrees.find(tree => pathKey(tree.path) === pathKey(choice))
  const name = tree?.node.name ?? folderLabel(choice)
  const roots = tree?.node.worktrees.map(tree => tree.path) ?? NO_ROOTS
  const rootsKey = JSON.stringify(roots)
  const registrations = JSON.stringify(projects.map(project => project.folder))
  const projectFolder = tree?.node.folder ?? choice
  const runs = useRunPresets(state => choice ? selectWorktree(state, choice) : undefined)
  const failed = useRunPresets(state => Boolean(choice && state.failed[pathKey(choice)]))
  const hasApi = Boolean(runPresetApi().runPresetsList)
  useEffect(() => {
    const roots: string[] = JSON.parse(rootsKey)
    if (choice && hasApi) void loadRunPresets(choice, roots.length ? roots : undefined)
  }, [choice, hasApi, rootsKey])
  useEffect(() => {
    if (!choice || !window.electronAPI.localNestedRepositoriesStatus || useNestedRepositories.getState().groups[pathKey(choice)]) return
    const roots: string[] = JSON.parse(rootsKey)
    const worktrees = (roots.length ? roots : [choice]).map(path => ({ path }))
    void refreshNestedRepositoryProject({ folder: projectFolder, folders: [projectFolder], worktrees }, JSON.parse(registrations), false)
  }, [choice, projectFolder, registrations, rootsKey])

  if (!hasApi) return <WorkspaceNote>실행 구성을 읽을 수 없습니다.</WorkspaceNote>
  return <div className="workspace-runs">
    <div className="workspace-runs-project">
      <select aria-label="실행 프로젝트" value={target ? tree?.path ?? target.folder : ''} onChange={event => {
        if (event.target.value) openRunPanel(event.target.value)
        else useWorkspacePanelStore.setState({ runTarget: null })
      }}>
        <option value="">{current ? `현재 터미널 · ${worktrees.find(tree => tree.path === current)?.node.name ?? folderLabel(current)}` : '프로젝트 선택'}</option>
        {target && !tree && <option value={target.folder}>{name}</option>}
        {worktrees.map(({ path, node, isMain, branch }) => <option key={pathKey(path)} value={path}>
          {isMain ? node.name : `${node.name} · ${branch ?? folderLabel(path)}`}
        </option>)}
      </select>
      {runs && <span className="workspace-runs-total">{runs.presets.length}개</span>}
    </div>
    {runs ? <RunTable key={runs.worktreeKey} runs={runs} name={name} roots={roots} branch={tree?.branch ?? null} target={target} />
      : <WorkspaceNote>{!choice ? '실행 구성을 볼 프로젝트를 선택하세요.'
        : failed ? '실행 구성을 읽지 못했습니다.' : '실행 구성을 읽는 중…'}</WorkspaceNote>}
  </div>
}

type RunDialog = { kind: 'preset'; preset: RunPreset | null }
  | { kind: 'bundle'; bundle: RunBundle | null }
  | { kind: 'order' }
  | { kind: 'diagnose' | 'send'; preset: RunPreset }

function RunTable({ runs, name, roots, branch, target }: {
  runs: WorktreeRuns
  name: string
  roots: string[]
  branch: string | null
  target: RunPanelTarget | null
}) {
  const { folder, projectKey, worktreeKey, presets, states, startOrder, startOrderConfigured, batch, bundles } = runs
  const nested = useNestedRepositories(state => state.groups[worktreeKey] ?? state.groups[pathKey(folder)])
  const pins = useRunSummary(state => state.pins[projectKey] ?? NO_PINS)
  const [query, setQuery] = useState('')
  const [status, setStatus] = useState<RunPanelStatus | null>(target?.status ?? null)
  const [bundleId, setBundleId] = useState(() => readBundleChoice(projectKey, bundles)?.id ?? '')
  const [selectedId, setSelectedId] = useState<string | undefined>(target?.presetId)
  const [menuId, setMenuId] = useState<string | null>(null)
  const [dialog, setDialog] = useState<RunDialog | null>(null)
  const [pointerIn, setPointerIn] = useState(false)
  const [focusIn, setFocusIn] = useState(false)
  const [revealId, setRevealId] = useState(target?.presetId)
  const filter = useRef<HTMLInputElement>(null)
  const table = useRef<HTMLDivElement>(null)
  const snapshot = useRef<{ key: string; groups: (RunPanelGroup & { stageIds?: string[] })[] } | null>(null)
  const bundle = bundles.find(item => item.id === bundleId) ?? null
  const commonBranch = branch ?? nested?.branch ?? null
  const stages = startOrderConfigured ? startOrder?.stages.map(stage => stage.ids) ?? NO_STAGES
    : batch && batch.status !== 'cancelled' ? batch.stages : NO_STAGES
  const stageById = new Map(stages.flatMap((ids, step) => ids.map(id => [id, step] as const)))

  useEffect(() => {
    setQuery('')
    setStatus(target?.status ?? null)
    setSelectedId(target?.presetId)
    setRevealId(target?.presetId)
    if (target?.presetId) setBundleId('')
  }, [target])

  const rows: RunPanelRow[] = presets.map(preset => {
    const state = states[preset.id] ?? IDLE_STATE
    const repo = repositoryForPreset(nested, preset.relative)
    const repoBranch = repo ? ('branch' in repo ? repo.branch ?? null : null) : commonBranch
    return { preset, state, step: stageById.get(preset.id), repository: repo?.folder,
      branch: repoBranch, branchDiffers: Boolean(repo && !repo.error && repoBranch !== commonBranch), port: runPanelPort(preset, state) }
  })
  const byId = new Map(rows.map(row => [row.preset.id, row]))
  const counts = { running: 0, crashed: 0, unresponsive: 0 }
  for (const { state } of rows) {
    const kind = runPanelStatus(state)
    if (state.status === 'running') counts.running += 1
    if (kind === 'crashed' || kind === 'unresponsive') counts[kind] += 1
  }
  const nextGroups = groupRunPanelRows(rows, query, status, bundle ? new Set(bundle.presetIds) : null)
    .map(group => ({ ...group, stageIds: group.step === undefined ? undefined : stages[group.step] }))
  const orderKey = JSON.stringify([query, status, bundle?.id, target?.presetId])
  const frozen = pointerIn || focusIn || Boolean(menuId)
  const groups = frozen && snapshot.current?.key === orderKey ? snapshot.current.groups : nextGroups
  useLayoutEffect(() => {
    snapshot.current = { key: orderKey, groups }
  }, [orderKey, groups])
  const shownIds = groups.flatMap(group => group.ids.filter(id => byId.has(id)))
  const activeId = selectedId && shownIds.includes(selectedId) ? selectedId : shownIds[0]
  const rowElement = (id: string) => table.current?.querySelector<HTMLTableRowElement>(`[data-workspace-run="${CSS.escape(id)}"]`)

  useLayoutEffect(() => {
    if (!revealId || !shownIds.includes(revealId)) return
    rowElement(revealId)?.scrollIntoView({ block: 'nearest' })
    setRevealId(undefined)
  }, [revealId, shownIds])

  const chooseBundle = (chosen: RunBundle | null) => {
    setBundleId(chosen?.id ?? '')
    writeBundleChoice(projectKey, chosen)
  }
  const projectActions = runProjectActions({
    runs, bundle, onAdd: () => setDialog({ kind: 'preset', preset: null }), onOrder: () => setDialog({ kind: 'order' }),
    onNewBundle: runPresetApi().runPresetBundleSave ? () => setDialog({ kind: 'bundle', bundle: null }) : undefined,
    onEditBundle: bundle ? () => setDialog({ kind: 'bundle', bundle }) : undefined
  })
  const chooseStatus = (kind: RunPanelStatus) => setStatus(value => value === kind ? null : kind)
  const clearFilter = () => { setQuery(''); setStatus(null) }
  const closeDialog = () => setDialog(null)
  const stopAll = projectActions.find(item => item.id === 'stopAll')!
  const startAll = projectActions.find(item => item.id === 'startAll')!
  const bundleAction = bundle && (projectActions.find(item => item.id === 'stopBundle' && item.enabled)
    ?? projectActions.find(item => item.id === 'startBundle'))
  const recovery = projectActions.filter(item => RECOVERY_ACTIONS.has(item.id))
  const activeStepId = batch?.status !== 'cancelled' ? batch?.stages[batch.index]?.[0] : undefined
  const activeStep = activeStepId ? stageById.get(activeStepId) : undefined

  const keyRow = (event: KeyboardEvent<HTMLTableRowElement>, id: string, actions: RunActionItem[]) => {
    if (event.target !== event.currentTarget || event.altKey || event.ctrlKey || event.metaKey) return
    const key = event.key.toLowerCase()
    if (key === 'arrowup' || key === 'arrowdown') {
      const next = shownIds[shownIds.indexOf(id) + (key === 'arrowup' ? -1 : 1)]
      if (next) rowElement(next)?.focus()
    } else if (key === 'enter') {
      setMenuId(id)
    } else {
      const wanted = key === 'l' ? ['log'] : key === 'r' ? ['restart']
        : key === ' ' ? ['stop', 'start', 'restart'] : []
      if (!wanted.length) return
      const action = actions.find(item => item.enabled && wanted.includes(item.id))
      if (action) void action.run()
    }
    event.preventDefault()
  }

  return <div className="workspace-run-list" onKeyDown={event => {
    if (event.defaultPrevented || menuId) return
    if (event.key === 'Escape' && (query || status)) { event.preventDefault(); clearFilter() }
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'f') {
      event.preventDefault()
      event.stopPropagation()
      filter.current?.focus()
    }
  }}>
    <div className="workspace-runs-controls">
      <div className="workspace-runs-search">
        <RiSearchLine aria-hidden="true" />
        <input ref={filter} value={query} onChange={event => setQuery(event.target.value)}
          aria-label="실행 구성 검색" placeholder="이름·폴더·포트" onKeyDown={event => {
            if (event.key === 'ArrowDown' && activeId) { event.preventDefault(); rowElement(activeId)?.focus() }
          }} />
        {query && <button type="button" title="검색 지우기" aria-label="검색 지우기" onClick={() => { setQuery(''); filter.current?.focus() }}>
          <RiCloseLine aria-hidden="true" />
        </button>}
      </div>
      <div className="workspace-runs-stats">
        {STATUS_FILTERS.map(kind => <button key={kind} type="button" data-run-status={kind} aria-pressed={status === kind}
          title={RUN_STATUS_LABELS[kind]} aria-label={`${RUN_STATUS_LABELS[kind]} ${counts[kind]}개`} onClick={() => chooseStatus(kind)}>
          <span aria-hidden="true">{STATUS_MARKS[kind]}</span> {counts[kind]}
        </button>)}
        {(query.trim() || status || bundle) && <span className="workspace-runs-matches" aria-live="polite">{shownIds.length}/{presets.length}</span>}
      </div>
      <div className="workspace-runs-commands">
        {bundles.length > 0 && <select aria-label="실행 묶음" value={bundle?.id ?? ''}
          onChange={event => chooseBundle(bundles.find(item => item.id === event.target.value) ?? null)}>
          <option value="">전체</option>
          {bundles.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}
        </select>}
        {bundleAction && <ActionButton item={bundleAction} text />}
        <ActionButton item={startAll} text />
        <ActionButton item={stopAll} text />
        <RunMenu label="실행 프로젝트 메뉴" actions={projectActions.filter(item => !['startAll', 'stopAll', 'panel', bundleAction?.id].includes(item.id)
          && !RECOVERY_ACTIONS.has(item.id))} />
      </div>
      {batch && batch.status !== 'cancelled' && <RunProgress batch={batch} actions={recovery} />}
    </div>
    <div className="workspace-runs-scroll" ref={table}
      onPointerEnter={() => setPointerIn(true)} onPointerLeave={() => setPointerIn(false)}
      onFocusCapture={() => setFocusIn(true)} onBlurCapture={event => {
        if (!(event.relatedTarget instanceof Node) || !event.currentTarget.contains(event.relatedTarget)) setFocusIn(false)
      }}>
      {!shownIds.length ? <WorkspaceNote>{presets.length ? '조건에 맞는 실행 구성이 없습니다.' : '등록된 실행 구성이 없습니다.'}</WorkspaceNote>
        : <table className="workspace-runs-table" aria-label="실행 구성">
          <colgroup><col className="run-col-step" /><col className="run-col-status" /><col /><col className="run-col-port" />
            <col className="run-col-branch" /><col className="run-col-actions" /></colgroup>
          <thead><tr><th scope="col">단계</th><th scope="col" aria-label="상태" /><th scope="col">이름</th><th scope="col">포트</th>
            <th scope="col">브랜치</th><th scope="col" aria-label="동작" /></tr></thead>
          {groups.map(group => {
            const members = group.ids.flatMap(id => byId.get(id) ?? [])
            if (!members.length) return null
            const ids = (group.stageIds ?? group.ids).filter(id => byId.has(id))
            const running = ids.filter(id => states[id]?.status === 'running').length
            const stageActions = group.step === undefined ? [] : runStageActions(runs, ids)
            return <tbody key={group.id}>
              {group.label && <tr className="workspace-runs-group" data-current={group.step !== undefined && group.step === activeStep || undefined}>
                <th colSpan={6} scope="rowgroup">
                  <div>
                    <span>{group.label}</span>
                    {group.id !== 'problems' && <small aria-label={`${ids.length}개 중 ${running}개 실행 중`}>{running}/{ids.length}</small>}
                    {stageActions[0] && <ActionButton item={stageActions[0]} text />}
                    {stageActions.length > 0 && <RunMenu label={`${group.label} 메뉴`} actions={stageActions} />}
                  </div>
                </th>
              </tr>}
              {members.map(({ preset, state, step, port, branch, branchDiffers }) => {
                const id = preset.id
                const kind = runPanelStatus(state)
                const pinned = pins.includes(id)
                const actions = runPresetActions({
                  runs, preset, pinned, onTogglePin: () => toggleRunPresetPin(projectKey, id),
                  onEdit: () => setDialog({ kind: 'preset', preset }),
                  onDiagnose: () => setDialog({ kind: 'diagnose', preset }),
                  onSend: () => setDialog({ kind: 'send', preset })
                }).filter(item => item.id !== 'panel')
                const primary = actions.find(item => item.enabled && (kind === 'unresponsive' ? item.id === 'restart' : ['start', 'stop', 'restart'].includes(item.id)))
                const open = actions.find(item => item.id === 'open' && item.enabled)
                const waiting = batch?.status === 'waiting' && batch.ids.includes(id)
                const queued = batch && batch.status !== 'cancelled' && batch.stages.slice(batch.index + 1).some(stage => stage.includes(id))
                const statusText = waiting ? `${RUN_STATUS_LABELS[kind]} · ${{ none: '진행', ready: '준비', log: '로그', url: '헬스 URL' }[batch.gate.kind]} 대기`
                  : queued && (kind === 'idle' || kind === 'stopped') ? '앞 단계 대기'
                    : state.failureReason ? `${RUN_STATUS_LABELS[kind]} · ${state.failureReason}` : RUN_STATUS_LABELS[kind]
                return <tr key={id} className="workspace-runs-row" data-workspace-run={id} data-run-status={kind}
                  data-selected={activeId === id || undefined} tabIndex={activeId === id ? 0 : -1}
                  onFocus={() => setSelectedId(id)} onKeyDown={event => keyRow(event, id, actions)}
                  onClick={event => { if (!(event.target instanceof Element && event.target.closest('button'))) event.currentTarget.focus() }}
                  onContextMenu={event => { event.preventDefault(); event.currentTarget.focus(); setMenuId(id) }}>
                  <td className="run-cell-step">{step === undefined ? '–' : step + 1}</td>
                  <td><span className="run-state-dot" aria-hidden="true" /></td>
                  <td className="run-cell-name" title={`${preset.name} · ${preset.relative} · ${statusText}`}>
                    <span>{pinned && <RiStarFill size={11} aria-label="고정됨" />}<strong>{preset.name}</strong></span>
                    <small>{statusText}</small>
                  </td>
                  <td className="run-cell-port">{port && open
                    ? <button type="button" tabIndex={-1} title={open.label} aria-label={`${preset.name} ${open.label} ${port}`} onClick={() => void open.run()}>{port}</button>
                    : port || '–'}</td>
                  <td className="run-cell-branch" title={branch ?? undefined} data-different={branchDiffers || undefined}>{branch || '–'}</td>
                  <td><div className="run-cell-actions">
                    {primary && <ActionButton item={primary} name={preset.name} />}
                    <RunMenu label={`${preset.name} 동작`} actions={actions} open={menuId === id}
                      onOpenChange={open => setMenuId(open ? id : null)} restoreFocus={() => rowElement(id)?.focus()} />
                  </div></td>
                </tr>
              })}
            </tbody>
          })}
        </table>}
    </div>
    {dialog?.kind === 'preset' && <RunPresetDialog folder={folder} projectName={name} roots={roots} preset={dialog.preset} onClose={closeDialog} />}
    {dialog?.kind === 'order' && startOrder && <RunStartOrderDialog folder={folder} projectName={name} presets={presets} order={startOrder} onClose={closeDialog} />}
    {dialog?.kind === 'bundle' && <RunBundleDialog folder={folder} runs={runs} bundle={dialog.bundle} onClose={closeDialog}
      onSaved={saved => { chooseBundle(saved); closeDialog() }} />}
    {dialog?.kind === 'diagnose' && <RunSuggestionsDialog folder={folder} presetId={dialog.preset.id} presetName={dialog.preset.name}
      proposals={cleanProposals(states[dialog.preset.id]?.proposals)} onClose={closeDialog} />}
    {dialog?.kind === 'send' && <RunSendDialog notice={{ folder, projectKey }} preset={dialog.preset} onClose={closeDialog} />}
  </div>
}

function ActionButton({ item, name, text }: { item: RunActionItem; name?: string; text?: boolean }) {
  const label = name ? `${name} ${item.label}` : item.label
  return <button type="button" data-run-action={item.id} disabled={!item.enabled} title={label}
    aria-label={label} tabIndex={name ? -1 : undefined} onClick={() => void item.run()}>
    <item.Icon size={13} aria-hidden="true" />{text && item.label}
  </button>
}

function RunMenu({ label, actions, open, onOpenChange, restoreFocus }: {
  label: string
  actions: RunActionItem[]
  open?: boolean
  onOpenChange?: (open: boolean) => void
  restoreFocus?: () => void
}) {
  return <DropdownMenu.Root modal={false} open={open} onOpenChange={onOpenChange}>
    <DropdownMenu.Trigger asChild>
      <button type="button" aria-label={label} title={label} tabIndex={restoreFocus ? -1 : undefined}>
        <RiMoreFill size={15} aria-hidden="true" />
      </button>
    </DropdownMenu.Trigger>
    <DropdownMenu.Portal>
      <DropdownMenu.Content align="end" sideOffset={4} collisionPadding={8} className="terminal-menu sidebar-popover"
        onCloseAutoFocus={event => {
          if (!restoreFocus) return
          event.preventDefault()
          if (document.activeElement === document.body) restoreFocus()
        }}>
        {actions.map(item => <DropdownMenu.Item key={item.id} disabled={!item.enabled}
          className={`terminal-menu-item${item.danger ? ' run-presets-danger' : ''}`}
          onSelect={() => void item.run()}><item.Icon size={15} aria-hidden="true" />{item.label}</DropdownMenu.Item>)}
      </DropdownMenu.Content>
    </DropdownMenu.Portal>
  </DropdownMenu.Root>
}

function RunProgress({ batch, actions }: {
  batch: Exclude<NonNullable<WorktreeRuns['batch']>, { status: 'cancelled' }>
  actions: RunActionItem[]
}) {
  const step = `${batch.index + 1}/${batch.total}단계`
  const paused = batch.status === 'paused' ? batch : null
  const detail = paused && { timeout: '대기 시간 초과', exited: '비정상 종료', startFailed: '시작 실패' }[paused.reason]
  return <div className="workspace-runs-progress" data-paused={Boolean(paused) || undefined}>
    <span role="status" title={paused?.error}>{step}{detail ? ` · ${detail}` : ''}</span>
    <progress aria-label="기동 순서 진행" max={batch.total} value={batch.index + 1} />
    {paused && <div className="workspace-runs-recovery">
      {actions.map(item => <ActionButton key={item.id} item={item} text />)}
    </div>}
  </div>
}
