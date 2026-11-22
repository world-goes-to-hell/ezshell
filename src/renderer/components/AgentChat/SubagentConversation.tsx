import { useEffect, useRef, useState, type CSSProperties } from 'react'
import { RiArrowLeftLine, RiSendPlane2Line, RiTerminalBoxLine } from 'react-icons/ri'
import type { AgentChatSubagent, AgentChatSubagentConversation } from '../../types'
import { subagentDisplayText } from '../../lib/agentChatItems'
import { AgentChatThemePicker } from './AgentChatThemePicker'

const ROUTE_LABELS = {
  direct: '직접 연결',
  relay: '부모를 통해 전달',
  'select-parent': '입력 대상 확인',
  'read-only': '읽기 전용'
}

export function SubagentConversation({ shellId, agent, kind, menuStyle, onBack, onShowTerminal }: {
  shellId: string
  agent: AgentChatSubagent
  kind: 'claude' | 'codex'
  menuStyle?: CSSProperties
  onBack: () => void
  onShowTerminal: () => void
}) {
  const [conversation, setConversation] = useState<AgentChatSubagentConversation | null>(null)
  const [loaded, setLoaded] = useState(false)
  const [draft, setDraft] = useState('')
  const [error, setError] = useState('')
  const [sending, setSending] = useState(false)
  const sendPending = useRef(false)
  const openedScope = useRef<string | null>(null)
  const [outbox, setOutbox] = useState<{ id: string; text: string; time: number; viaParent: boolean }[]>([])
  const log = useRef<HTMLDivElement>(null)
  const follow = useRef(true)
  const name = agent.name || '서브에이전트'
  const canRead = Boolean(window.electronAPI.agentChatSubagentConversation)
  const mode = conversation?.mode
  const canSend = mode === 'direct' || mode === 'relay'
  const messages = conversation?.messages

  useEffect(() => {
    let cancelled = false
    let timer: number | undefined
    const load = window.electronAPI.agentChatSubagentConversation
    async function refresh() {
      const view = await load?.(shellId, agent.id).catch(() => null) ?? null
      if (cancelled) return
      if (view && openedScope.current && openedScope.current !== view.scope) {
        setConversation(null)
        setError('부모 대화가 바뀌었습니다. 서브에이전트 대화를 다시 열어 주세요.')
        return
      }
      if (view) openedScope.current = view.scope
      setLoaded(true)
      setConversation(view)
      if (load) timer = window.setTimeout(() => void refresh(), 1250)
    }
    void refresh()
    return () => { cancelled = true; window.clearTimeout(timer) }
  }, [shellId, agent.id])

  useEffect(() => {
    if (follow.current && log.current) log.current.scrollTop = log.current.scrollHeight
  }, [messages, outbox.length])

  async function send() {
    const text = draft.trim()
    const deliver = window.electronAPI.agentChatSubagentSend
    if (!canSend || !conversation || !text || !deliver || sendPending.current) return
    sendPending.current = true
    setSending(true)
    setError('')
    try {
      const result = await deliver({ shellId, agentId: agent.id, scope: conversation.scope, text, mode })
      if (!result.ok) { setError(result.error); return }
      follow.current = true
      setDraft('')
      setOutbox(current => [...current.slice(-19), { id: crypto.randomUUID(), text, time: Date.now(), viaParent: mode === 'relay' }])
    } catch {
      setError('메시지를 보내지 못했습니다.')
    } finally {
      sendPending.current = false
      setSending(false)
    }
  }

  const fallback = subagentDisplayText(agent.result, kind)
  return (
    <section className="agent-chat-subagent-conversation" aria-label={`${name} 대화`} onContextMenu={event => event.stopPropagation()}>
      <header className="agent-chat-head">
        <button className="agent-chat-head-btn" type="button" onClick={onBack}>
          <RiArrowLeftLine aria-hidden /> 부모 대화
        </button>
        <strong className="agent-chat-title" title={name}>{name}</strong>
        {mode && <span className="agent-chat-status">{ROUTE_LABELS[mode]}</span>}
        <button className="agent-chat-head-btn" type="button" onClick={onShowTerminal}><RiTerminalBoxLine aria-hidden /> 터미널</button>
        <AgentChatThemePicker toolbar menuStyle={menuStyle} />
      </header>
      <div className="agent-chat-log" ref={log} onScroll={event => {
        const { scrollTop, scrollHeight, clientHeight } = event.currentTarget
        follow.current = scrollHeight - clientHeight - scrollTop < 32
      }}>
        {messages?.map(message => <div key={message.id} className="agent-chat-subagent-message" data-role={message.role}>
          {message.text}
        </div>)}
        {!messages?.length && fallback && <div className="agent-chat-subagent-message" data-role="assistant">{fallback}</div>}
        {!messages?.length && !fallback && <p className="agent-chat-empty">
          {!canRead ? '서브에이전트 대화를 열려면 ezShell을 다시 시작해 주세요.'
            : loaded ? conversation ? '대화 기록 대기 중' : '대화를 불러올 수 없습니다.' : '대화를 불러오는 중…'}
        </p>}
        {outbox.filter(sent => !messages?.some(message => message.role === 'user'
          && message.time !== null && message.time >= sent.time - 1000 && message.text.trim() === sent.text)).map(sent => (
          <div key={sent.id} className="agent-chat-subagent-message" data-role="user">
            {sent.text}<small>{sent.viaParent ? '부모에게 전달 요청' : 'CLI 입력 전송됨'}</small>
          </div>
        ))}
      </div>
      {mode === 'select-parent' && <div className="agent-chat-banner" role="status">터미널에서 부모 대화 또는 이 서브에이전트의 대화를 선택해 주세요.</div>}
      {error && <div className="agent-chat-banner" role="status">{error}</div>}
      <form className="agent-chat-composer" onSubmit={event => { event.preventDefault(); void send() }}>
        <textarea className="agent-chat-input agent-chat-subagent-input" value={draft} maxLength={16_000}
          readOnly={sending} rows={Math.min(6, draft.split('\n').length)}
          placeholder={`${name}에게 보낼 메시지`} aria-label={`${name}에게 보낼 메시지`}
          onChange={event => setDraft(event.target.value)}
          onKeyDown={event => {
            if (event.key !== 'Enter' || event.shiftKey || event.nativeEvent.isComposing) return
            event.preventDefault()
            void send()
          }} />
        <button className="agent-chat-send" type="submit" aria-label="서브에이전트에게 보내기"
          disabled={!canSend || !draft.trim() || sending}><RiSendPlane2Line aria-hidden /></button>
      </form>
    </section>
  )
}
