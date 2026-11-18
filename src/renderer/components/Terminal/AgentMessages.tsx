import { useEffect, useLayoutEffect, useRef, useState, type FormEvent } from 'react'
import { createPortal } from 'react-dom'
import * as Dialog from '@radix-ui/react-dialog'
import { RiMailLine } from 'react-icons/ri'
import { create } from 'zustand'
import type { AgentMessage, AgentMessageDelivery, AgentMessagesSnapshot } from '../../types'
import { toast } from '../../stores/toastStore'
import './AgentMessages.css'

const USER = 'user'
const label = (id: string) => id === USER ? '나' : id
const instructions = 'ezShell의 다른 에이전트와 협업할 때 ezshell agent list --json 으로 대상을 찾고, ezshell message send --to <ID> --text "요청" 으로 보내세요. ezshell message inbox --unread --json 으로 받은 메시지를 보고, ezshell message reply --reply-to <메시지-ID> --text "답변" 으로 답장하세요. 답장이 필요 없는 메시지는 ezshell message ack --id <메시지-ID> 로 확인하세요.'

interface AgentMessagesState {
  snapshot: AgentMessagesSnapshot
  panes: Record<string, string>
  panel: { agentId?: string } | null
}

export const useAgentMessagesStore = create<AgentMessagesState>(() => ({
  snapshot: { revision: -1, agents: [], messages: [] },
  panes: {},
  panel: null
}))
const useMessages = useAgentMessagesStore

function openPanel(agentId?: string) {
  useMessages.setState({ panel: { agentId } })
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
  const inbox = document.querySelector<HTMLElement>('.agent-messages-button')
  return inbox && isVisible(inbox) ? inbox : undefined
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

export function AgentMessagesHost() {
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
      {panel && <AgentMessagesDialog key={panel.agentId ?? 'all'} initialAgent={panel.agentId} onClose={() => useMessages.setState({ panel: null })} />}
    </>
  )
}

function unreadCount(messages: AgentMessage[], ids: Set<string>) {
  return messages.reduce((count, message) => count + Number(!message.read && ids.has(message.to)), 0)
}

export function AgentMessagesButton() {
  const count = useMessages(state => state.snapshot.messages.filter(message => !message.read).length)
  return (
    <button type="button" className="sidebar-footer-btn agent-messages-button" onClick={() => openPanel()} title="에이전트 메시지" aria-label={count ? `에이전트 메시지, 읽지 않음 ${count}개` : '에이전트 메시지'}>
      <RiMailLine size={18} />
      {count > 0 && <span className="agent-mail-count">{count}</span>}
    </button>
  )
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
    <button type="button" className="agent-pane-mail" data-unread={count > 0} onClick={() => openPanel(agent.id)} title={`${agent.id} 메시지함`} aria-label={`${agent.id} 메시지함`}>
      <RiMailLine size={15} />
      {count > 0 && <span className="agent-mail-count">{count}</span>}
    </button>
  )
}

function AgentMessagesDialog({ initialAgent, onClose }: { initialAgent?: string; onClose: () => void }) {
  const { agents, messages } = useMessages(state => state.snapshot)
  const [selection, setSelection] = useState(initialAgent)
  const [text, setText] = useState('')
  const [reply, setReply] = useState<AgentMessage>()
  const [error, setError] = useState('')
  const [sending, setSending] = useState(false)
  const selected = agents.find(agent => agent.id === selection) ?? agents.find(agent => agent.mcpConnected) ?? agents[0]
  const thread = messages.filter(message => message.from === selected?.id || message.to === selected?.id)
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (!selected?.mcpConnected || !text.trim() || sending) return
    setSending(true)
    setError('')
    try {
      const result = await window.electronAPI.agentMessageSend({ to: selected.id, text, replyTo: reply?.id })
      if (!result.success) setError(result.error)
      else { setText(''); setReply(undefined) }
    } catch {
      setError('메시지를 보내지 못했습니다.')
    } finally {
      setSending(false)
    }
  }
  const acknowledge = async (id: string) => {
    try {
      const result = await window.electronAPI.agentMessageAck(id)
      if (!result.success) setError(result.error)
    } catch {
      setError('메시지를 읽음으로 표시하지 못했습니다.')
    }
  }
  const copyHelp = async () => {
    try {
      await navigator.clipboard.writeText(instructions)
      toast.success('에이전트에게 전달할 사용법을 복사했습니다.')
    } catch {
      setError('사용법을 복사하지 못했습니다.')
    }
  }
  return (
    <Dialog.Root open onOpenChange={open => { if (!open) onClose() }}>
      <Dialog.Portal>
        <Dialog.Overlay className="modal-overlay" />
        <Dialog.Content className="modal-content agent-messages-dialog" aria-describedby={undefined}>
          <Dialog.Title className="modal-title"><RiMailLine size={20} />에이전트 메시지</Dialog.Title>
          {selected ? (
            <div className="form-group">
              <label htmlFor="agent-messages-session">에이전트</label>
              <select id="agent-messages-session" value={selected.id} onChange={event => { setSelection(event.target.value); setReply(undefined); setError('') }} disabled={sending}>
                {agents.map(agent => <option key={agent.id} value={agent.id}>{agent.id}{agent.active ? '' : ' (종료)'} · {agent.cwd}</option>)}
              </select>
              {selected.active && (
                <p className="form-hint" role="status">
                  {selected.mcpConnected ? '메시지 MCP 연결됨 (ezshell-cli-mcp)' : '메시지 MCP 연결을 기다리는 중 (ezshell-cli-mcp)'}
                </p>
              )}
            </div>
          ) : <p className="form-hint">로컬 작업에서 Codex 또는 Claude Code를 열면 메시지를 보낼 수 있습니다.</p>}
          {selected && (
            <>
              <div className="agent-message-thread" role="log" aria-label={`${selected.id} 메시지`}>
                {thread.length === 0 && <p className="form-hint">아직 메시지가 없습니다.</p>}
                {thread.map(message => (
                  <article key={message.id} className="agent-thread-message">
                    <header>
                      <strong>{label(message.from)} → {label(message.to)}</strong>
                      <span>{message.read ? '읽음' : '전달됨'}</span>
                    </header>
                    <p>{message.text}</p>
                    {message.to === USER && (
                      <div className="agent-thread-actions">
                        {!message.read && <button type="button" onClick={() => void acknowledge(message.id)}>읽음 표시</button>}
                        {selected.mcpConnected && <button type="button" onClick={() => setReply(message)}>답장</button>}
                      </div>
                    )}
                  </article>
                ))}
              </div>
              {selected.mcpConnected && (
                <form className="agent-message-compose" onSubmit={submit}>
                  {reply && <button type="button" onClick={() => setReply(undefined)}>답장 취소</button>}
                  <textarea aria-label="메시지 내용" placeholder={reply ? '답장 쓰기' : '메시지 쓰기'} rows={3} maxLength={8000} value={text} onChange={event => setText(event.target.value)} />
                  <button type="submit" className="btn-primary" disabled={sending || !text.trim()}>보내기</button>
                </form>
              )}
            </>
          )}
          {error && <p className="agent-message-error" role="alert">{error}</p>}
          <div className="modal-actions">
            <button type="button" className="btn-secondary" onClick={() => void copyHelp()}>CLI 사용법 복사</button>
            <Dialog.Close className="btn-secondary">닫기</Dialog.Close>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}
