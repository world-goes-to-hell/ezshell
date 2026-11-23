import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import * as Dialog from '@radix-ui/react-dialog'
import * as Tabs from '@radix-ui/react-tabs'
import { RiListUnordered, RiMailLine, RiNodeTree, RiTeamLine, RiUser3Line } from 'react-icons/ri'
import { create } from 'zustand'
import { useShallow } from 'zustand/react/shallow'
import type { AgentMessage, AgentMessageDelivery, AgentMessageSession, AgentMessagesSnapshot, LocalAgent } from '../../types'
import { folderLabel, isInsidePath, pathKey } from '../../lib/localWorkspaceTree'
import { visibleTerminalId } from '../../lib/localTerminalPane'
import { projectOfFolder, type GroupProject } from '../../lib/tabGroups'
import { AGENT_MESSAGE_VIEW_KEY, agentMessageMap, parseAgentMessageView, type MessageState } from '../../lib/agentMessageMap'
import { useTerminalStore } from '../../stores/terminalStore'
import { AGENT_PROVIDER_ICONS } from '../ui/agentProviderIcons'
import { SelectMenu } from '../ui/SelectMenu'
import { AgentMessageMap, MESSAGE_STATE_LABELS } from './AgentMessageMap'
import './AgentMessages.css'

const USER = 'user'
const ALL = 'all'
const label = (id: string) => id === USER ? '나' : id

function MessageProviderIcon({ kind }: { kind?: LocalAgent | typeof USER | typeof ALL }) {
  if (!kind) return null
  const Icon = kind === USER ? RiUser3Line : kind === ALL ? RiTeamLine : AGENT_PROVIDER_ICONS[kind]
  return <Icon className="agent-message-provider" data-kind={kind} size={14} aria-hidden="true" />
}

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

export function isAgentWorking(agent: AgentMessageSession): boolean {
  return agent.active && agent.status === 'working' && !agent.waitingForReply
}

/** Local tabs with at least one working agent, including tabs in the background. */
export function useWorkingLocalTabs(): ReadonlySet<string> {
  return useMessages(useShallow(({ snapshot, panes }) => {
    const tabs = new Set<string>()
    for (const agent of snapshot.agents) {
      const tabId = panes[agent.shellId]
      if (tabId && isAgentWorking(agent)) tabs.add(tabId)
    }
    return tabs
  }))
}

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
    // The chat covers the terminal's mail button. In chat, deliveries land on its bell.
    const mail = pane?.querySelector<HTMLElement>(pane.querySelector('.agent-chat-cover')
      ? '.agent-chat-parent:not([inert]) .agent-chat-notification' : '.agent-pane-mail')
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

type DeliveryKind = LocalAgent | typeof USER

/** An arrival as shown: who sent it to whom, and what each is (for their icons) */
interface ShownDelivery extends AgentMessageDelivery {
  fromKind?: DeliveryKind
  toKind?: DeliveryKind
}

/** A message flying from the sender's pane to the receiver's before the arrival card shows */
interface DeliveryFlightState {
  shown: ShownDelivery
  from: { x: number; y: number }
  to: { x: number; y: number }
}

const FLIGHT_MS = 430
const CARD_MS = 2400

/** The latest agent with this id in the message list (the sender's shell and kind are not in the event) */
function agentOf(id: string) {
  const agents = useMessages.getState().snapshot.agents
  for (let index = agents.length - 1; index >= 0; index--) if (agents[index].id === id) return agents[index]
  return undefined
}

function kindOf(id: string): DeliveryKind | undefined {
  if (id === USER) return USER
  const kind = agentOf(id)?.kind
  return kind === 'claude' || kind === 'codex' ? kind : undefined
}

const centerOf = (element: HTMLElement) => {
  const box = element.getBoundingClientRect()
  return { x: box.left + box.width / 2, y: box.top + box.height / 2 }
}

/** Where the flight goes, when both ends are on screen and motion is welcome; otherwise only the card shows */
function flightFor(shown: ShownDelivery): DeliveryFlightState | null {
  if (document.hidden || matchMedia('(prefers-reduced-motion: reduce)').matches) return null
  const fromShell = shown.from === USER ? undefined : agentOf(shown.from)?.shellId || undefined
  const source = deliveryAnchor(fromShell)
  const destination = deliveryAnchor(shown.toShell)
  if (!source || !destination || source === destination) return null
  return { shown, from: centerOf(source), to: centerOf(destination) }
}

function DeliveryFlight({ flight, onLanded }: { flight: DeliveryFlightState; onLanded: () => void }) {
  const chipRef = useRef<HTMLSpanElement>(null)
  const landedRef = useRef(onLanded)
  landedRef.current = onLanded
  useLayoutEffect(() => {
    const chip = chipRef.current
    if (!chip) return
    const dx = flight.to.x - flight.from.x
    const dy = flight.to.y - flight.from.y
    // A small arc upward on the way, fading a little as it lands
    const frames = [0, 0.25, 0.5, 0.75, 1].map(progress => ({
      transform: `translate3d(${dx * progress}px, ${dy * progress - 92 * progress * (1 - progress)}px, 0) translate(-50%, -50%)`,
      opacity: progress === 1 ? 0.35 : 1
    }))
    const animation = chip.animate(frames, { duration: FLIGHT_MS, easing: 'ease-out' })
    let stopped = false
    const land = () => { if (!stopped) landedRef.current() }
    void animation.finished.then(land, land)
    // The panes moved: the path is wrong, so land at once (the card finds the receiver again)
    const cancel = () => animation.cancel()
    window.addEventListener('resize', cancel, { once: true })
    return () => {
      stopped = true
      window.removeEventListener('resize', cancel)
      animation.cancel()
    }
  }, [flight])
  return createPortal(
    <span ref={chipRef} className="agent-message-flight" aria-hidden="true"
      style={{ left: flight.from.x, top: flight.from.y, transform: 'translate(-50%, -50%)' }}>
      <MessageProviderIcon kind={flight.shown.fromKind} />
      <RiMailLine size={13} />
      메시지
    </span>,
    document.body
  )
}

function AgentDeliveryNotice({ delivery }: { delivery: ShownDelivery | null }) {
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
            <strong>
              <MessageProviderIcon kind={delivery.fromKind} />{label(delivery.from)} → <MessageProviderIcon kind={delivery.toKind} />{label(delivery.to)}
            </strong>
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
  const [delivery, setDelivery] = useState<ShownDelivery | null>(null)
  const [flight, setFlight] = useState<DeliveryFlightState | null>(null)
  const cardTimer = useRef<number | undefined>(undefined)
  // The arrival card, for a while (after the flight, or at once when nothing flies)
  const showCard = (shown: ShownDelivery) => {
    window.clearTimeout(cardTimer.current)
    setDelivery(shown)
    cardTimer.current = window.setTimeout(() => setDelivery(null), CARD_MS)
  }
  useEffect(() => {
    let active = true
    const stopState = window.electronAPI.onAgentMessagesState(receive)
    const hideDelivery = () => {
      window.clearTimeout(cardTimer.current)
      setDelivery(null)
      setFlight(null)
    }
    const stopDelivery = window.electronAPI.onAgentMessageDelivered(event => {
      if (document.hidden) return
      const shown: ShownDelivery = { ...event, fromKind: kindOf(event.from), toKind: kindOf(event.to) }
      const next = flightFor(shown)
      if (next) {
        setFlight(next)
      } else {
        setFlight(null)
        showCard(shown)
      }
    })
    document.addEventListener('visibilitychange', hideDelivery)
    void window.electronAPI.agentMessagesSnapshot().then(snapshot => { if (active) receive(snapshot) })
    return () => {
      active = false
      stopState()
      stopDelivery()
      window.clearTimeout(cardTimer.current)
      document.removeEventListener('visibilitychange', hideDelivery)
      useMessages.setState({ panel: null })
    }
  }, [])
  return (
    <>
      {flight && <DeliveryFlight key={flight.shown.id} flight={flight} onLanded={() => { setFlight(null); showCard(flight.shown) }} />}
      <AgentDeliveryNotice delivery={delivery} />
      {panel && <AgentMessagesDialog key={panel.agentId ?? ALL} initialAgent={panel.agentId} sourceTabId={panel.tabId}
        currentGroup={currentGroup} projects={projects} onClose={() => useMessages.setState({ panel: null })} />}
    </>
  )
}

// Read: the recipient agent took it from its inbox (seenAt), or it was answered. A message to the user is
// read once the user handles it.
const isRead = (message: AgentMessage) => message.read || Boolean(message.seenAt)
const counts = (message: AgentMessage) => !isRead(message)
const readTitle = (message: AgentMessage) => (message.seenAt ? `${new Date(message.seenAt).toLocaleString()} 에 읽음` : undefined)

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

/** The agent of a pane's shell and its unread messages. */
export function usePaneAgentMail(shellId: string) {
  const agent = useMessages(state => state.snapshot.agents.find(item => item.shellId === shellId))
  const count = useMessages(state => agent ? unreadCount(state.snapshot.messages, new Set([agent.id])) : 0)
  return { agent, count }
}

export function AgentPaneMessages({ shellId, tabId }: { shellId: string; tabId: string }) {
  const { agent, count } = usePaneAgentMail(shellId)
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

const mapMessageTime = new Intl.DateTimeFormat('ko-KR', { month: 'numeric', day: 'numeric', hour: 'numeric', minute: '2-digit' })

function MessageThread({ messages, name, actor, states }: {
  messages: readonly AgentMessage[]
  name: string
  actor: (id: string) => ReactNode
  states?: ReadonlyMap<string, MessageState>
}) {
  return (
    <div className="agent-message-thread" role="log" tabIndex={0} aria-label={name}>
      {messages.length === 0 && <p className="form-hint">아직 메시지가 없습니다.</p>}
      {messages.map(message => {
        const state = states?.get(message.id)
        const read = state ? state !== 'unread' : isRead(message)
        return (
          <article key={message.id} className="agent-thread-message">
            <header>
              <strong className="agent-message-route">{actor(message.from)} → {actor(message.to)}</strong>
              <span className="agent-read-state" data-read={read} title={readTitle(message)}>
                {state ? MESSAGE_STATE_LABELS[state] : read ? '읽음' : '안 읽음'}
              </span>
            </header>
            <p>{message.text}</p>
            {states && <time className="agent-message-map-time" dateTime={new Date(message.sentAt).toISOString()}>{mapMessageTime.format(message.sentAt)}</time>}
          </article>
        )
      })}
    </div>
  )
}

function AgentMessagesDialog({ initialAgent, sourceTabId, currentGroup, projects, onClose }: DialogProps) {
  const { agents, messages } = useMessages(state => state.snapshot)
  const panes = useMessages(state => state.panes)
  const [selection, setSelection] = useState(initialAgent ?? ALL)
  const [edgeSelection, setEdgeSelection] = useState<string>()
  const [view, setView] = useState(() => parseAgentMessageView(localStorage.getItem(AGENT_MESSAGE_VIEW_KEY)) ?? 'map')
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
  const localAgents = useMemo(() => agents.filter(agent => {
    const owner = projectOfFolder(agent.cwd, projects)
    if (project) return owner?.key === project.key
    if (!folder || owner) return false
    return tabFolder ? isInsidePath(agent.cwd, tabFolder) : pathKey(agent.cwd) === pathKey(folder)
  }), [agents, folder, project, projects, tabFolder])
  const agentsById = new Map(localAgents.map(agent => [agent.id, agent]))
  const map = useMemo(() => agentMessageMap(localAgents, messages), [localAgents, messages])
  const selectedEdge = map.edges.find(edge => edge.id === edgeSelection)
  const selected = agentsById.has(selection) ? selection : ALL
  const mapAgent = !selectedEdge && map.nodes.some(({ agent }) => agent.id === selected) ? selected : undefined
  const thread = messages.filter(({ from, to }) => {
    if (selected === ALL) return agentsById.has(from) && agentsById.has(to)
    return (from === selected && (agentsById.has(to) || to === USER))
      || (to === selected && (agentsById.has(from) || from === USER))
  })
  const actor = (id: string) => (
    <span className="agent-message-actor">
      <MessageProviderIcon kind={id === USER ? USER : agentsById.get(id)?.kind} />
      <span className="agent-message-actor-name">{label(id)}</span>
    </span>
  )
  const mapThreadName = selectedEdge ? `${selectedEdge.first} ↔ ${selectedEdge.second}` : mapAgent
  const changeView = (value: string) => {
    const next = parseAgentMessageView(value)
    if (!next) return
    setView(next)
    localStorage.setItem(AGENT_MESSAGE_VIEW_KEY, next)
  }
  return (
    <Dialog.Root open onOpenChange={open => { if (!open) onClose() }}>
      <Dialog.Portal>
        <Dialog.Overlay className="modal-overlay" />
        <Dialog.Content className="modal-content agent-messages-dialog" data-view={workspaceName ? view : undefined} aria-describedby={undefined}>
          <Dialog.Title className="modal-title"><RiMailLine size={20} />에이전트 메시지</Dialog.Title>
          {workspaceName ? (
            <Tabs.Root value={view} onValueChange={changeView}>
              <div className="agent-message-map-toolbar">
                <span className="agent-message-workspace" title={workspaceName}>{workspaceName}</span>
                <Tabs.List className="agent-message-map-switch" aria-label="에이전트 메시지 보기">
                  <Tabs.Trigger value="map"><RiNodeTree size={15} aria-hidden="true" />관계도</Tabs.Trigger>
                  <Tabs.Trigger value="list"><RiListUnordered size={15} aria-hidden="true" />목록</Tabs.Trigger>
                </Tabs.List>
              </div>
              <Tabs.Content value="map" className="agent-message-map-body">
                <AgentMessageMap key={project?.key ?? folder} model={map} selectedAgent={mapAgent} selectedEdge={selectedEdge?.id}
                  onSelectAgent={id => { setSelection(id); setEdgeSelection(undefined) }} onSelectEdge={setEdgeSelection} />
                <aside className="agent-message-map-detail" aria-label="선택한 메시지">
                  <h3>{selectedEdge ? <>{actor(selectedEdge.first)} ↔ {actor(selectedEdge.second)}</> : mapAgent ? actor(mapAgent) : '메시지'}</h3>
                  {mapThreadName ? (
                    <MessageThread key={mapThreadName} name={`${mapThreadName} 메시지`} actor={actor} states={map.messageStates}
                      messages={selectedEdge?.messages ?? [...thread].sort((a, b) => a.sentAt - b.sentAt)} />
                  ) : <p className="agent-message-map-empty">에이전트나 연결선을 선택하면 메시지를 볼 수 있습니다.</p>}
                </aside>
              </Tabs.Content>
              <Tabs.Content value="list">
                <div className="form-group">
                  <div className="agent-message-filter"><label htmlFor="agent-messages-session">에이전트</label></div>
                  <SelectMenu
                    id="agent-messages-session"
                    ariaLabel="에이전트"
                    value={selected}
                    onChange={id => { setSelection(id); setEdgeSelection(undefined) }}
                    options={[
                      { value: ALL, label: '전체', icon: <MessageProviderIcon kind={ALL} /> },
                      ...localAgents.map(agent => ({
                        value: agent.id,
                        label: `${agent.id}${agent.active ? '' : ' (종료)'}`,
                        icon: <MessageProviderIcon kind={agent.kind} />
                      }))
                    ]}
                  />
                </div>
                <MessageThread messages={thread} name={selected === ALL ? `${workspaceName} 에이전트 간 메시지` : `${selected} 메시지`} actor={actor} />
              </Tabs.Content>
            </Tabs.Root>
          ) : <p className="form-hint">로컬 작업을 선택하면 에이전트 메시지를 볼 수 있습니다.</p>}
          <div className="modal-actions">
            <Dialog.Close className="btn-secondary">닫기</Dialog.Close>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}
