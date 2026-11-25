import { useEffect, useRef, useState } from 'react'
import * as DropdownMenu from '@radix-ui/react-dropdown-menu'
import { RiGlobalLine, RiRefreshLine, RiStopCircleLine, RiTerminalBoxLine } from 'react-icons/ri'
import { SiNodedotjs, SiSpringboot, SiVuedotjs } from 'react-icons/si'
import type { LocalDevelopmentRun } from '../../types'
import { changeDevelopmentRun, developmentRunLabel, developmentRunPort, developmentRunsForTab, useDevelopmentRuns } from '../../lib/developmentRun'
import { getLocalPaneShellId } from '../../lib/localPaneShells'
import { focusTabPane } from '../../lib/paneFocus'
import { MAIN_PANE, paneIds } from '../../lib/splitTree'
import { useTerminalStore } from '../../stores/terminalStore'
import { toast } from '../../stores/toastStore'
import { useRunPresets } from '../../stores/runPresetStore'
import './TerminalContextMenu.css'
import './DevelopmentRunStatus.css'

/**
 * The shells of servers started from a run preset: their state is the preset row's on the sidebar card
 * (docs/plan/2026-11-25-local-project-run.md), so the old chip and its buttons leave them alone (the tab's
 * status dot stays: it shows the state with the sidebar folded)
 */
function usePresetShells(): ReadonlySet<string> {
  const worktrees = useRunPresets(state => state.worktrees)
  const shells = new Set<string>()
  for (const project of Object.values(worktrees)) {
    for (const state of Object.values(project.states)) if (state.shellId) shells.add(state.shellId)
  }
  return shells
}

export function DevelopmentTabDots({ tabId }: { tabId: string }) {
  const runs = useDevelopmentRuns(state => state.runs)
  return developmentRunsForTab(tabId, runs).map(({ id, run }) => (
    <span key={id} className="development-status-dot" data-status={run.status} role="img"
      aria-label={developmentRunLabel(run)} title={`${run.label} · ${developmentRunLabel(run)}`} />
  ))
}

function DevelopmentRunChip({ id, tabId, run }: { id: string; tabId: string; run: LocalDevelopmentRun }) {
  const [open, setOpen] = useState(false)
  const hover = useRef<ReturnType<typeof setTimeout> | null>(null)
  const cancelHover = () => { if (hover.current) clearTimeout(hover.current); hover.current = null }
  useEffect(() => cancelHover, [])
  const status = developmentRunLabel(run)
  const address = developmentRunPort(run.url)
  const Icon = run.name === 'Spring Boot' ? SiSpringboot : run.name === 'Vue' ? SiVuedotjs : SiNodedotjs
  const focusLog = () => {
    const { terminals, focusTerminal } = useTerminalStore.getState()
    const tree = terminals.get(tabId)?.splitTree
    const pane = (tree ? paneIds(tree) : [MAIN_PANE]).find(pane => getLocalPaneShellId(tabId, pane) === id)
    if (pane) focusTabPane(focusTerminal, tabId, pane)
  }
  const openBrowser = async () => {
    if (!run.url) return
    focusLog()
    try {
      const result = await window.electronAPI.browserReviewOpenLink(run.url, 'internal')
      if (!result.success) toast.error('브라우저 열기', result.error)
    } catch { toast.error('브라우저를 열지 못했습니다') }
  }
  const transitioning = run.status === 'starting' || run.status === 'stopping'
  return (
    <DropdownMenu.Root open={open} onOpenChange={setOpen} modal={false}>
      <DropdownMenu.Trigger asChild>
        <button type="button" className="development-status-chip" data-status={run.status} data-development-shell={id}
          aria-label={`${run.label} ${status}${address ? ` ${address}` : ''}`}
          title={open ? undefined : `${run.label} · ${status}${run.url ? ` · ${run.url}` : ''}`}
          onPointerEnter={event => {
            if (event.pointerType === 'mouse' && !open) hover.current = setTimeout(() => setOpen(true), 220)
          }}
          onPointerLeave={cancelHover}
          onContextMenu={event => { event.preventDefault(); event.stopPropagation(); cancelHover(); setOpen(true) }}>
          <Icon size={13} aria-hidden="true" />
          <span className="development-status-dot" data-status={run.status} aria-hidden="true" />
          <span>{status}</span>
          {address && <span className="development-status-port">{address}</span>}
        </button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content className="terminal-menu sidebar-popover" side="bottom" align="end" sideOffset={4} collisionPadding={8}>
          <DropdownMenu.Item className="terminal-menu-item" disabled={transitioning} onSelect={() => void changeDevelopmentRun(id, run.taskId, 'restart')}>
            <RiRefreshLine size={15} aria-hidden="true" /> 재기동
          </DropdownMenu.Item>
          <DropdownMenu.Item className="terminal-menu-item" disabled={run.status !== 'running'} onSelect={() => void changeDevelopmentRun(id, run.taskId, 'stop')}>
            <RiStopCircleLine size={15} aria-hidden="true" /> 중지
          </DropdownMenu.Item>
          {run.url && run.status === 'running' && <DropdownMenu.Item className="terminal-menu-item" onSelect={() => void openBrowser()}>
            <RiGlobalLine size={15} aria-hidden="true" /> 브라우저로 열기
          </DropdownMenu.Item>}
          <DropdownMenu.Item className="terminal-menu-item" onSelect={focusLog}>
            <RiTerminalBoxLine size={15} aria-hidden="true" /> 로그 보기
          </DropdownMenu.Item>
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  )
}

export function DevelopmentRunChips({ tabId }: { tabId: string }) {
  const runs = useDevelopmentRuns(state => state.runs)
  const presetShells = usePresetShells()
  return developmentRunsForTab(tabId, runs).filter(({ id }) => !presetShells.has(id)).map(({ id, run }) => <DevelopmentRunChip key={id} id={id} tabId={tabId} run={run} />)
}
