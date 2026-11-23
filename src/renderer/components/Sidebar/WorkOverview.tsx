import { useCallback, useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type RefObject } from 'react'
import * as Dialog from '@radix-ui/react-dialog'
import { RiArrowLeftLine, RiArrowRightUpLine, RiCloseLine, RiFolder3Line, RiGitBranchLine } from 'react-icons/ri'
import type { TabGroupView } from '../../hooks/useTabGroups'
import { assignTabs, folderLabel } from '../../lib/localWorkspaceTree'
import { focusTabPane, focusPaneInput } from '../../lib/paneFocus'
import { MAIN_PANE } from '../../lib/splitTree'
import { previewTabHost, tabHost } from '../../lib/tabHosts'
import { useTerminalStore } from '../../stores/terminalStore'
import type { AgentMessageSession } from '../../types'
import { useAgentMessagesStore } from '../Terminal/AgentMessages'
import { localAgentAppearance } from './LocalSessionAgents'
import './WorkOverview.css'

const DOUBLE_TAB_MS = 320
const PREVIEW_OPEN_MS = 300
const PREVIEW_CLOSE_MS = 420
const OPEN_DIALOG = '[role="dialog"]:not([data-state="closed"]), [role="alertdialog"]:not([data-state="closed"])'
type WorkView = Pick<TabGroupView, 'projectNodes' | 'groups'>
type AgentEntry = { agent: AgentMessageSession; tabId: string }
type PreviewRequest = { id: string; focus: boolean; anchor: HTMLButtonElement }

export function WorkOverview({ groupView }: { groupView: WorkView }) {
  const [overview, setOverview] = useState<{ backdropUrl: string | null } | null>(null)
  const pending = useRef<symbol | null>(null)
  const returnFocus = useRef<HTMLElement | null>(null)
  const close = () => {
    window.electronAPI.hideWorkOverview()
    setOverview(null)
  }

  useEffect(() => () => {
    pending.current = null
    window.electronAPI.hideWorkOverview()
  }, [])

  useEffect(() => () => {
    if (overview?.backdropUrl) URL.revokeObjectURL(overview.backdropUrl)
  }, [overview])

  useEffect(() => {
    if (overview) return
    let first: { at: number; target: HTMLElement | null } | null = null
    const reset = () => { first = null }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.repeat) return
      if (pending.current) {
        if (event.key === 'Escape') {
          event.preventDefault()
          event.stopPropagation()
          pending.current = null
          window.electronAPI.hideWorkOverview()
        }
        return
      }
      if (event.key !== 'Tab' || event.shiftKey || event.altKey || event.ctrlKey || event.metaKey || event.isComposing || event.defaultPrevented) {
        reset()
        return
      }
      const target = event.target instanceof HTMLElement ? event.target : null
      if (document.querySelector(OPEN_DIALOG) || target?.closest('.monaco-editor, [contenteditable="true"]')) {
        reset()
        return
      }
      const now = performance.now()
      if (!first || now - first.at > DOUBLE_TAB_MS) {
        first = { at: now, target }
        return
      }
      event.preventDefault()
      event.stopPropagation()
      const from = first.target
      reset()
      open(from)
    }
    const open = (from: HTMLElement | null) => {
      returnFocus.current = from
      const request = Symbol()
      pending.current = request
      void window.electronAPI.showWorkOverview().then(result => {
        if (pending.current !== request) return
        pending.current = null
        if (result) {
          const backdropUrl = result.backdrop ? URL.createObjectURL(new Blob([result.backdrop], { type: 'image/jpeg' })) : null
          setOverview({ backdropUrl })
        }
      }).catch(() => {
        if (pending.current !== request) return
        pending.current = null
        window.electronAPI.hideWorkOverview()
      })
    }
    // Tab Tab pressed in another program: main brought this window forward (src/globalDoubleTab.js)
    const stopRequests = window.electronAPI.onWorkOverviewRequest?.(() => {
      if (pending.current || document.querySelector(OPEN_DIALOG)) return
      reset()
      open(document.activeElement instanceof HTMLElement ? document.activeElement : null)
    })
    window.addEventListener('keydown', onKeyDown, true)
    window.addEventListener('pointerdown', reset, true)
    window.addEventListener('blur', reset)
    return () => {
      stopRequests?.()
      window.removeEventListener('keydown', onKeyDown, true)
      window.removeEventListener('pointerdown', reset, true)
      window.removeEventListener('blur', reset)
    }
  }, [overview])

  return (
    <Dialog.Root open={Boolean(overview)} onOpenChange={open => { if (!open) close() }}>
      {overview && <WorkOverviewDialog groupView={groupView} backdropUrl={overview.backdropUrl} returnFocus={returnFocus} close={close} />}
    </Dialog.Root>
  )
}

function positionPreview(anchor: HTMLElement): CSSProperties {
  const margin = 20
  const gap = 10
  const box = anchor.getBoundingClientRect()
  const left = box.left - margin - gap
  const right = innerWidth - box.right - margin - gap
  const maxHeight = Math.min(460, innerHeight - 2 * margin)
  if (Math.max(left, right) >= 360) {
    const width = Math.min(680, Math.max(left, right))
    return {
      width, height: maxHeight,
      left: right >= left ? box.right + gap : box.left - gap - width,
      top: Math.min(innerHeight - margin - maxHeight, Math.max(margin, box.top - 30))
    }
  }

  const above = box.top - margin - gap
  const below = innerHeight - box.bottom - margin - gap
  const width = Math.min(680, innerWidth - 2 * margin)
  const height = Math.min(maxHeight, Math.max(above, below, 180))
  return {
    width, height,
    left: Math.max(margin, Math.min(innerWidth - margin - width, box.left)),
    top: Math.max(margin, Math.min(innerHeight - margin - height, below >= above ? box.bottom + gap : box.top - gap - height))
  }
}

function WorkOverviewDialog({ groupView, backdropUrl, returnFocus, close }: {
  groupView: WorkView
  backdropUrl: string | null
  returnFocus: RefObject<HTMLElement | null>
  close: () => void
}) {
  const terminals = useTerminalStore(state => state.terminals)
  const focusTerminal = useTerminalStore(state => state.focusTerminal)
  const agents = useAgentMessagesStore(state => state.snapshot.agents)
  const paneTabs = useAgentMessagesStore(state => state.panes)
  const [request, setRequest] = useState<PreviewRequest | null>(null)
  const [position, setPosition] = useState<CSSProperties>()
  const previewPanel = useRef<HTMLElement>(null)
  const title = useRef<HTMLHeadingElement>(null)
  const pressedTarget = useRef<EventTarget | null>(null)
  const timer = useRef<number | undefined>(undefined)
  const jumping = useRef(false)
  const clearTimer = useCallback(() => window.clearTimeout(timer.current), [])
  useEffect(() => clearTimer, [clearTimer])
  useLayoutEffect(() => {
    if (!request) return
    const reposition = () => setPosition(positionPreview(request.anchor))
    reposition()
    window.addEventListener('resize', reposition)
    return () => window.removeEventListener('resize', reposition)
  }, [request])

  const { projectNodes, groups } = groupView
  const localTabs = [...terminals].flatMap(([id, terminal]) => terminal.local ? [{ id, cwd: terminal.local.cwd }] : [])
  const assignment = assignTabs(localTabs, projectNodes.flatMap(project => project.worktrees.map(tree => tree.path)))
  const unregistered = new Set(assignment.others)
  const entries = agents.flatMap(agent => {
    const tabId = paneTabs[agent.shellId]
    return agent.active && tabId && terminals.get(tabId)?.local ? [{ agent, tabId }] : []
  })
  const entriesByTab = new Map<string, AgentEntry[]>()
  for (const entry of entries) {
    const list = entriesByTab.get(entry.tabId) ?? []
    list.push(entry)
    entriesByTab.set(entry.tabId, list)
  }
  const byTabs = (ids: readonly string[]) => ids.flatMap(id => entriesByTab.get(id) ?? [])
  const sections = projectNodes.map(project => ({
    key: project.folder, name: project.name, path: project.folder,
    worktrees: project.worktrees.map(tree => ({ ...tree, entries: byTabs(assignment.byWorktree.get(tree.path) ?? []) }))
  }))
  for (const group of groups) {
    const ids = group.tabIds.filter(id => unregistered.has(id))
    if (ids.length === 0) continue
    const path = terminals.get(ids[0])?.local?.cwd ?? ''
    sections.push({
      key: group.key, name: path ? group.label : '다른 로컬 터미널', path,
      worktrees: [{ path, branch: null, isMain: true, entries: byTabs(ids) }]
    })
  }

  const preview = request && entries.find(entry => entry.agent.id === request.id)
  useEffect(() => {
    if (request && !preview) setRequest(null)
  }, [request, preview])

  const dismissPreview = (restoreFocus = false) => {
    clearTimer()
    setRequest(null)
    if (restoreFocus && preview) document.querySelector<HTMLElement>(`.work-overview-agent[data-agent-id="${CSS.escape(preview.agent.id)}"]`)?.focus({ preventScroll: true })
  }
  const leavePreview = useCallback(() => {
    clearTimer()
    timer.current = window.setTimeout(() => {
      const panel = previewPanel.current
      if (panel && (panel.matches(':hover') || panel.contains(document.activeElement))) return
      setRequest(null)
    }, PREVIEW_CLOSE_MS)
  }, [clearTimer])

  const previewOpen = Boolean(preview)
  useLayoutEffect(() => {
    const panel = previewPanel.current
    if (!previewOpen || !panel) return
    // The tab is physically inside the preview and belongs to another React portal.
    // Native pointer events follow the DOM boundary shared by the header and the tab.
    const onEnter = (event: PointerEvent) => { if (event.pointerType !== 'touch') clearTimer() }
    const onLeave = (event: PointerEvent) => { if (event.pointerType !== 'touch') leavePreview() }
    panel.addEventListener('pointerenter', onEnter)
    panel.addEventListener('pointerleave', onLeave)
    return () => {
      panel.removeEventListener('pointerenter', onEnter)
      panel.removeEventListener('pointerleave', onLeave)
    }
  }, [previewOpen, clearTimer, leavePreview])

  const jump = ({ agent, tabId }: AgentEntry) => {
    const pane = tabHost(tabId).querySelector<HTMLElement>(`[data-local-shell-id="${CSS.escape(agent.shellId)}"]`)
    jumping.current = true
    close()
    focusTabPane(focusTerminal, tabId, pane?.dataset.pane ?? MAIN_PANE)
  }

  const renderAgent = (entry: AgentEntry) => {
    const { agent } = entry
    const { name, label, description, icons, status } = localAgentAppearance(agent)
    return (
      <li key={agent.id}>
        <button type="button" className="work-overview-agent" data-agent-id={agent.id} data-status={status}
          data-previewing={preview?.agent.id === agent.id || undefined}
          aria-label={description} aria-keyshortcuts="ArrowRight"
          onPointerEnter={event => {
            if (event.pointerType === 'touch') return
            clearTimer()
            if (previewPanel.current?.contains(document.activeElement)) return
            const anchor = event.currentTarget
            timer.current = window.setTimeout(() => setRequest({ id: agent.id, focus: false, anchor }), PREVIEW_OPEN_MS)
          }}
          onPointerLeave={event => { if (event.pointerType !== 'touch') leavePreview() }}
          onKeyDown={event => {
            if (event.key !== 'ArrowRight') return
            event.preventDefault()
            clearTimer()
            setRequest({ id: agent.id, focus: true, anchor: event.currentTarget })
          }}
          onClick={() => jump(entry)}>
          {icons}
          <span className="work-overview-agent-name">{name}</span>
          <span className="work-overview-status">{label}</span>
          <RiArrowRightUpLine className="work-overview-jump" aria-hidden />
        </button>
      </li>
    )
  }

  return (
    <Dialog.Portal>
      <Dialog.Overlay className="work-overview-backdrop">
        {backdropUrl && <img src={backdropUrl} alt="" className="work-overview-monitor" />}
      </Dialog.Overlay>
      <Dialog.Content className="work-overview" aria-describedby={undefined}
        onPointerDownCapture={event => { pressedTarget.current = event.target }}
        onClick={event => {
          const target = event.target
          if (target !== pressedTarget.current || event.ctrlKey) return
          if (target === event.currentTarget || (target instanceof HTMLElement &&
            target.matches('.work-overview-board, .work-overview-heading, .work-overview-grid'))) close()
        }}
        onOpenAutoFocus={event => { event.preventDefault(); title.current?.focus({ preventScroll: true }) }}
        onCloseAutoFocus={event => {
          event.preventDefault()
          if (!jumping.current && returnFocus.current?.isConnected) returnFocus.current.focus({ preventScroll: true })
        }}
        onEscapeKeyDown={event => {
          if (!preview) return
          event.preventDefault()
          event.stopPropagation()
          dismissPreview(true)
        }}>
        <div className="work-overview-board">
          <header className="work-overview-heading">
            <Dialog.Title ref={title} tabIndex={-1}>로컬 작업 현황</Dialog.Title>
            <span className="work-overview-help">마우스를 올려 미리보기 · 클릭해 이동</span>
            <Dialog.Close type="button" className="work-overview-icon" aria-label="로컬 작업 현황 닫기" title="닫기 (Esc)"><RiCloseLine size={20} /></Dialog.Close>
          </header>
          <div className="work-overview-grid">
            {sections.length === 0 && <p className="work-overview-empty">표시할 로컬 작업이 없습니다.</p>}
            {sections.map((section, index) => (
              <section key={section.key} className="work-overview-card work-overview-project" style={{ animationDelay: `${Math.min(index, 7) * 35}ms` }}>
                <h3 title={section.path || undefined}><RiFolder3Line aria-hidden />{section.name}</h3>
                {section.worktrees.map(tree => (
                  <div key={tree.path} className="work-overview-worktree">
                    {(tree.branch || section.worktrees.length > 1) && (
                      <div className="work-overview-branch" title={tree.path}><RiGitBranchLine aria-hidden />{tree.branch ?? folderLabel(tree.path)}</div>
                    )}
                    {tree.entries.length
                      ? <ul className="work-overview-agents">{tree.entries.map(renderAgent)}</ul>
                      : <p className="work-overview-empty">실행 중인 에이전트 없음</p>}
                  </div>
                ))}
              </section>
            ))}
          </div>
        </div>
        {preview && (
          <section className="work-overview-card work-overview-preview" ref={previewPanel} style={position} aria-label="에이전트 미리보기">
            <header className="work-overview-header">
              <button type="button" className="work-overview-icon" aria-label="작업 목록으로 돌아가기" title="작업 목록으로 돌아가기 (Esc)" onClick={() => dismissPreview(true)}>
                <RiArrowLeftLine size={18} />
              </button>
              <h3>{localAgentAppearance(preview.agent).description}</h3>
              <button type="button" className="work-overview-icon" aria-label="에이전트 창으로 이동" title="에이전트 창으로 이동" onClick={() => jump(preview)}>
                <RiArrowRightUpLine size={18} />
              </button>
            </header>
            <AgentPreview key={`${preview.tabId}:${preview.agent.shellId}`} entry={preview} focus={request?.focus ?? false} />
          </section>
        )}
      </Dialog.Content>
    </Dialog.Portal>
  )
}

function AgentPreview({ entry: { tabId, agent }, focus }: { entry: AgentEntry; focus: boolean }) {
  const ref = useRef<HTMLDivElement>(null)
  const paneSelector = `[data-local-shell-id="${CSS.escape(agent.shellId)}"]`
  useLayoutEffect(() => {
    if (ref.current) return previewTabHost(tabId, ref.current)
  }, [tabId])
  useEffect(() => {
    if (!focus) return
    const frame = requestAnimationFrame(() => {
      const pane = ref.current?.querySelector<HTMLElement>(paneSelector)
      if (pane) focusPaneInput(pane)
    })
    return () => cancelAnimationFrame(frame)
  }, [focus, paneSelector])

  return (
    <div className="work-overview-preview-host" ref={ref}>
      <style>{`.work-overview-preview-host .local-terminal-tab > .local-terminal-pane:not(${paneSelector}) { display: none; }`}</style>
    </div>
  )
}
