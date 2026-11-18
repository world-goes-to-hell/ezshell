import { useEffect, useState, type FormEvent } from 'react'
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

function anchor(shellId?: string): HTMLElement | null {
  if (!shellId) return document.querySelector('.agent-messages-button')
  const pane = document.querySelector<HTMLElement>(`[data-local-shell-id="${CSS.escape(shellId)}"]`)
  if (pane && isVisible(pane)) return pane.querySelector('.agent-pane-mail') ?? pane
  const tabId = pane?.dataset.localTabId ?? useMessages.getState().panes[shellId]
  if (!tabId) return null
  return [...document.querySelectorAll<HTMLElement>(`:is(.terminal-tab, .split-pane-tab-item)[data-tab-id="${CSS.escape(tabId)}"]`)].find(isVisible) ?? null
}

function playDelivery({ fromShell, toShell }: AgentMessageDelivery) {
  const reduce = matchMedia('(prefers-reduced-motion: reduce)')
  if (document.hidden || reduce.matches) return
  const source = anchor(fromShell)
  const destination = anchor(toShell)
  if (!destination || !isVisible(destination)) return

  const emphasize = () => {
    if (destination.isConnected && !reduce.matches && !document.hidden) {
      destination.animate([{ boxShadow: 'inset 0 0 0 2px var(--accent)' }, { boxShadow: 'inset 0 0 0 0 transparent' }], 380)
    }
  }
  if (!source || !isVisible(source) || source === destination) {
    emphasize()
    return
  }
  const from = source.getBoundingClientRect()
  const to = destination.getBoundingClientRect()
  const dx = to.left + to.width / 2 - (from.left + from.width / 2)
  const dy = to.top + to.height / 2 - (from.top + from.height / 2)
  const chip = document.createElement('span')
  chip.className = 'agent-message-flight'
  chip.textContent = '메시지'
  chip.setAttribute('aria-hidden', 'true')
  chip.style.left = `${from.left + from.width / 2}px`
  chip.style.top = `${from.top + from.height / 2}px`
  document.body.append(chip)
  const frames = [0, .25, .5, .75, 1].map(progress => ({
    transform: `translate3d(${dx * progress}px, ${dy * progress - 92 * progress * (1 - progress)}px, 0) translate(-50%, -50%)`,
    opacity: progress === 1 ? .35 : 1
  }))
  const flight = chip.animate(frames, { duration: 430, easing: 'ease-out' })
  const cancel = () => flight.cancel()
  reduce.addEventListener('change', cancel)
  window.addEventListener('resize', cancel, { once: true })
  document.addEventListener('visibilitychange', cancel, { once: true })
  void flight.finished.then(emphasize, () => {}).finally(() => {
    chip.remove()
    reduce.removeEventListener('change', cancel)
    window.removeEventListener('resize', cancel)
    document.removeEventListener('visibilitychange', cancel)
  })
}

export function AgentMessagesHost() {
  const panel = useMessages(state => state.panel)
  useEffect(() => {
    let active = true
    const stopState = window.electronAPI.onAgentMessagesState(receive)
    const stopDelivery = window.electronAPI.onAgentMessageDelivered(playDelivery)
    void window.electronAPI.agentMessagesSnapshot().then(snapshot => { if (active) receive(snapshot) })
    return () => {
      active = false
      stopState()
      stopDelivery()
      useMessages.setState({ panel: null })
    }
  }, [])
  return panel ? <AgentMessagesDialog key={panel.agentId ?? 'all'} initialAgent={panel.agentId} onClose={() => useMessages.setState({ panel: null })} /> : null
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
    <button type="button" className="agent-pane-mail" onClick={() => openPanel(agent.id)} title={`${agent.id} 메시지함`} aria-label={`${agent.id} 메시지함`}>
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
