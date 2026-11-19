import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import * as Dialog from '@radix-ui/react-dialog'
import { RiMailLine } from 'react-icons/ri'
import { create } from 'zustand'
import type { AgentMessage, AgentMessageDelivery, AgentMessagesSnapshot } from '../../types'
import { folderLabel, isInsidePath, pathKey } from '../../lib/localWorkspaceTree'
import { visibleTerminalId } from '../../lib/localTerminalPane'
import { projectOfFolder, type GroupProject } from '../../lib/tabGroups'
import { useTerminalStore } from '../../stores/terminalStore'
import './AgentMessages.css'

const USER = 'user'
const ALL = 'all'
const label = (id: string) => id === USER ? '나' : id

interface AgentMessagesState {
  snapshot: AgentMessagesSnapshot
  panes: Record<string, string>
  panel: { agentId?: string; tabId?: string } | null
}

export const useAgentMessagesStore = create<AgentMessagesState>(() => ({
  snapshot: { revision: -1, agents: [], messages: [] },
  panes: {},
  panel: null
}))
const useMessages = useAgentMessagesStore

/** Opens the message panel (all agents, or one agent's inbox) */
export function openAgentMessages(agentId?: string, tabId?: string) {
  useMessages.setState({ panel: { agentId, tabId } })
}

function receive(snapshot: AgentMessagesSnapshot | null) {
  if (snapshot && snapshot.revision >= useMessages.getState().snapshot.revision) useMessages.setState({ snapshot })
}

function isVisible(element: HTMLElement | null): boolean {
  if (!element || getComputedStyle(element).visibility !== 'visible') return false
  const box = element.getBoundingClientRect()
  return box.width > 0 && box.height > 0 && box.right > 0 && box.bottom > 0 && box.left < innerWidth && box.top < innerHeight
}

function deliveryAnchor(shellId?: string): HTMLElement | undefined {
  if (shellId) {
    const pane = document.querySelector<HTMLElement>(`[data-local-shell-id="${CSS.escape(shellId)}"]`)
    const mail = pane?.querySelector<HTMLElement>('.agent-pane-mail')
    if (mail && isVisible(mail)) return mail
    const tabId = pane?.dataset.localTabId ?? useMessages.getState().panes[shellId]
    if (tabId) {
      const tabs = document.querySelectorAll<HTMLElement>(`:is(.terminal-tab, .split-pane-tab-item)[data-tab-id="${CSS.escape(tabId)}"]`)
      const tab = [...tabs].find(isVisible)
      const badge = tab?.querySelector<HTMLElement>('.agent-tab-mail')
      if (badge && isVisible(badge)) return badge
      if (tab) return tab
    }
  }
  return undefined
}

function AgentDeliveryNotice({ delivery }: { delivery: AgentMessageDelivery | null }) {
  const noticeRef = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    const notice = noticeRef.current
    if (!delivery || !notice) return
    const position = () => {
      const target = deliveryAnchor(delivery.toShell)
      const edge = 8
      const box = target?.getBoundingClientRect()
      const width = notice.offsetWidth
      const height = notice.offsetHeight
      const left = box
        ? (box.left + width <= innerWidth - edge ? box.left : box.right - width)
        : innerWidth - width - edge
      const top = box
        ? (box.bottom + edge + height <= innerHeight ? box.bottom + edge : box.top - edge - height)
        : edge
      notice.style.left = `${Math.max(edge, Math.min(left, innerWidth - width - edge))}px`
      notice.style.top = `${Math.max(edge, top)}px`
      return target
    }
    const target = position()
    const reduce = matchMedia('(prefers-reduced-motion: reduce)')
    const highlight = !reduce.matches && target?.animate([
      { boxShadow: '0 0 0 2px var(--accent)' },
      { boxShadow: '0 0 0 4px transparent' }
    ], { duration: 600, easing: 'ease-out' })
    window.addEventListener('resize', position)
    window.addEventListener('scroll', position, true)
    return () => {
      if (highlight) highlight.cancel()
      window.removeEventListener('resize', position)
      window.removeEventListener('scroll', position, true)
    }
  }, [delivery])
  return createPortal(
    <div role="status" className="agent-delivery-status">
      {delivery && (
        <div ref={noticeRef} key={delivery.id} className="agent-delivery-notice">
          <RiMailLine size={16} aria-hidden="true" />
          <div className="agent-delivery-text">
            <span>메시지 도착</span>
            <strong>{label(delivery.from)} → {label(delivery.to)}</strong>
          </div>
        </div>
      )}
    </div>,
    document.body
  )
}

interface WorkspaceSelection {
  currentGroup: string | null
  projects: readonly GroupProject[]
}

export function AgentMessagesHost({ currentGroup, projects }: WorkspaceSelection) {
  const panel = useMessages(state => state.panel)
  const [delivery, setDelivery] = useState<AgentMessageDelivery | null>(null)
  useEffect(() => {
    let active = true
    let timer: number | undefined
    const stopState = window.electronAPI.onAgentMessagesState(receive)
    const hideDelivery = () => {
      window.clearTimeout(timer)
      setDelivery(null)
    }
    const stopDelivery = window.electronAPI.onAgentMessageDelivered(event => {
      if (document.hidden) return
      window.clearTimeout(timer)
      setDelivery(event)
      timer = window.setTimeout(hideDelivery, 2400)
    })
    document.addEventListener('visibilitychange', hideDelivery)
    void window.electronAPI.agentMessagesSnapshot().then(snapshot => { if (active) receive(snapshot) })
    return () => {
      active = false
      stopState()
      stopDelivery()
      window.clearTimeout(timer)
      document.removeEventListener('visibilitychange', hideDelivery)
      useMessages.setState({ panel: null })
    }
  }, [])
  return (
    <>
      <AgentDeliveryNotice delivery={delivery} />
      {panel && <AgentMessagesDialog key={panel.agentId ?? ALL} initialAgent={panel.agentId} sourceTabId={panel.tabId}
        currentGroup={currentGroup} projects={projects} onClose={() => useMessages.setState({ panel: null })} />}
    </>
  )
}

// A receipt between agents is read when its recipient next looks; until then it is not mail to count
const counts = (message: AgentMessage) => !message.read && (!message.receipt || message.to === USER)

function unreadCount(messages: AgentMessage[], ids: Set<string>) {
  return messages.reduce((count, message) => count + Number(counts(message) && ids.has(message.to)), 0)
}

export function AgentTabMessages({ tabId }: { tabId: string }) {
  const count = useMessages(state => {
    const ids = new Set(state.snapshot.agents.filter(agent => state.panes[agent.shellId] === tabId).map(agent => agent.id))
    return unreadCount(state.snapshot.messages, ids)
  })
  return count > 0 ? <span className="agent-tab-mail agent-mail-count" aria-label={`읽지 않은 에이전트 메시지 ${count}개`} title={`읽지 않은 메시지 ${count}개`}>{count}</span> : null
}

export function AgentPaneMessages({ shellId, tabId }: { shellId: string; tabId: string }) {
  const agent = useMessages(state => state.snapshot.agents.find(item => item.shellId === shellId))
  const count = useMessages(state => agent ? unreadCount(state.snapshot.messages, new Set([agent.id])) : 0)
  useEffect(() => {
    useMessages.setState(state => ({ panes: { ...state.panes, [shellId]: tabId } }))
    return () => {
      useMessages.setState(state => {
        if (state.panes[shellId] !== tabId) return state
        const panes = { ...state.panes }
        delete panes[shellId]
        return { panes }
      })
    }
  }, [shellId, tabId])
  if (!agent) return null
  return (
    <button type="button" className="agent-pane-mail" data-unread={count > 0} onClick={() => openAgentMessages(agent.id, tabId)} title={`${agent.id} 메시지함`} aria-label={`${agent.id} 메시지함`}>
      <RiMailLine size={15} />
      {count > 0 && <span className="agent-mail-count">{count}</span>}
    </button>
  )
}

interface DialogProps extends WorkspaceSelection {
  initialAgent?: string
  sourceTabId?: string
  onClose: () => void
}

function AgentMessagesDialog({ initialAgent, sourceTabId, currentGroup, projects, onClose }: DialogProps) {
  const { agents, messages } = useMessages(state => state.snapshot)
  const panes = useMessages(state => state.panes)
  const [selection, setSelection] = useState(initialAgent ?? ALL)
  const tab = useTerminalStore(state => {
    const id = sourceTabId ?? visibleTerminalId(state.layout, state.activeTerminalId)
    return id ? state.terminals.get(id) : undefined
  })
  const tabFolder = tab?.local?.cwd
  const paneAgent = tab?.local && agents.find(agent => panes[agent.shellId] === tab.id && (initialAgent ? agent.id === initialAgent : agent.active))
  const folder = tabFolder ?? (paneAgent ? paneAgent.cwd : undefined)
  const project = projects.find(item => item.key === currentGroup) ?? projectOfFolder(folder, projects)
  const workspaceName = project?.name ?? (folder ? folderLabel(folder) : null)
  // Match archived agents by working directory as well, so closing a pane does not hide its messages.
  const localAgents = agents.filter(agent => {
    const owner = projectOfFolder(agent.cwd, projects)
    if (project) return owner?.key === project.key
    if (!folder || owner) return false
    return tabFolder ? isInsidePath(agent.cwd, tabFolder) : pathKey(agent.cwd) === pathKey(folder)
  })
  const ids = new Set(localAgents.map(agent => agent.id))
  const selected = ids.has(selection) ? selection : ALL
  const thread = messages.filter(({ from, to }) => {
    if (selected === ALL) return ids.has(from) && ids.has(to)
    return (from === selected && (ids.has(to) || to === USER))
      || (to === selected && (ids.has(from) || from === USER))
  })
  return (
    <Dialog.Root open onOpenChange={open => { if (!open) onClose() }}>
      <Dialog.Portal>
        <Dialog.Overlay className="modal-overlay" />
        <Dialog.Content className="modal-content agent-messages-dialog" aria-describedby={undefined}>
          <Dialog.Title className="modal-title"><RiMailLine size={20} />에이전트 메시지</Dialog.Title>
          {workspaceName ? (
            <>
              <div className="form-group">
                <div className="agent-message-filter">
                  <label htmlFor="agent-messages-session">에이전트</label>
                  <span className="agent-message-workspace" title={workspaceName}>{workspaceName}</span>
                </div>
                <select id="agent-messages-session" value={selected} onChange={event => setSelection(event.target.value)}>
                  <option value={ALL}>전체</option>
                  {localAgents.map(agent => <option key={agent.id} value={agent.id}>{agent.id}{agent.active ? '' : ' (종료)'}</option>)}
                </select>
              </div>
              <div className="agent-message-thread" role="log" tabIndex={0} aria-label={selected === ALL ? `${workspaceName} 에이전트 간 메시지` : `${selected} 메시지`}>
                {thread.length === 0 && <p className="form-hint">아직 메시지가 없습니다.</p>}
                {thread.map(message => (
                  <article key={message.id} className={`agent-thread-message${message.receipt ? ' is-receipt' : ''}`}>
                    <header>
                      <strong>{label(message.from)} → {label(message.to)}</strong>
                      {message.receipt && <span className="agent-receipt-tag" title="요청을 받았다는 확인입니다. 결과는 따로 답장으로 옵니다.">수신 확인</span>}
                      <span>{message.read ? '읽음' : '전달됨'}</span>
                    </header>
                    <p>{message.text}</p>
                  </article>
                ))}
              </div>
            </>
          ) : <p className="form-hint">로컬 작업을 선택하면 에이전트 메시지를 볼 수 있습니다.</p>}
          <div className="modal-actions">
            <Dialog.Close className="btn-secondary">닫기</Dialog.Close>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}
