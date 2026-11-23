import { useId, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import { RiArrowRightSLine, RiCheckDoubleLine, RiCheckLine, RiMailUnreadLine, RiReplyLine } from 'react-icons/ri'
import { agentIdentityColor, agentSearchTerm } from '../../lib/agentIdentity'
import type { MessageState } from '../../lib/agentMessageMap'
import { matchName } from '../../lib/containerSearch'
import type { AgentMessage } from '../../types'

const dateFormat = new Intl.DateTimeFormat('ko-KR', { dateStyle: 'long' })
const timeFormat = new Intl.DateTimeFormat('ko-KR', { hour: 'numeric', minute: '2-digit' })
const PREVIEW_LINES = 4
const readStates = {
  unread: { label: '안 읽음', Icon: RiMailUnreadLine },
  seen: { label: '읽음', Icon: RiCheckLine },
  answered: { label: '답함', Icon: RiCheckDoubleLine }
}

export function MessageSearchText({ text, term }: { text: string; term: string }) {
  const parts = term && matchName(text.normalize('NFC'), [term])
  return parts ? parts.map((part, index) => part.isMatch ? <mark key={index}>{part.text}</mark> : part.text) : text
}

function MessageBubble({ message, original, state, term, name }: {
  message: AgentMessage
  original?: AgentMessage
  state: MessageState
  term: string
  name: string
}) {
  const bodyId = useId()
  const body = useRef<HTMLParagraphElement>(null)
  const [expansion, setExpansion] = useState<{ term: string; open: boolean }>()
  const [overflows, setOverflows] = useState(false)
  const open = expansion?.term === term ? expansion.open : Boolean(term && agentSearchTerm(message.text).includes(term))
  const sentAt = new Date(message.sentAt)
  const quote = original?.text.trimStart().split(/\r\n?|\n/, 1)[0]
  const { label, Icon } = readStates[state]

  useLayoutEffect(() => {
    const element = body.current
    if (!element) return
    const measure = () => {
      const lineHeight = parseFloat(getComputedStyle(element).lineHeight)
      setOverflows(element.scrollHeight > PREVIEW_LINES * lineHeight + 1)
    }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(element)
    return () => observer.disconnect()
  }, [message.text])

  return (
    <article className="agent-thread-message" aria-label={name}>
      <div className="agent-message-bubble">
        {quote && <blockquote className="agent-message-reply" aria-label="원 메시지">
          <RiReplyLine aria-hidden="true" />
          <span title={quote}><MessageSearchText text={quote} term={term} /></span>
        </blockquote>}
        <p ref={body} id={bodyId} className="agent-message-body" data-collapsed={!open} style={{ '--message-preview-lines': PREVIEW_LINES } as CSSProperties}>
          <MessageSearchText text={message.text} term={term} />
        </p>
        {overflows && <button type="button" className="agent-message-expand" aria-controls={bodyId} aria-expanded={open}
          onClick={() => setExpansion({ term, open: !open })}>{open ? '접기' : '더 보기'}</button>}
      </div>
      <footer className="agent-message-meta">
        <time dateTime={sentAt.toISOString()} title={sentAt.toLocaleString()}>{timeFormat.format(sentAt)}</time>
        <span className="agent-read-state" data-state={state} title={message.seenAt ? new Date(message.seenAt).toLocaleString() : undefined}>
          <Icon aria-hidden="true" />{label}
        </span>
      </footer>
    </article>
  )
}

interface MessageGroup {
  from: string
  to: string
  messages: AgentMessage[]
}

function groupMessages(messages: readonly AgentMessage[]) {
  const days: { label: string; groups: MessageGroup[] }[] = []
  for (const message of messages) {
    const label = dateFormat.format(message.sentAt)
    let day = days[days.length - 1]
    if (!day || day.label !== label) {
      day = { label, groups: [] }
      days.push(day)
    }
    const group = day.groups[day.groups.length - 1]
    if (group?.from === message.from && group.to === message.to) group.messages.push(message)
    else day.groups.push({ from: message.from, to: message.to, messages: [message] })
  }
  return days
}

export function AgentMessageThread({ messages, originals, name, actor, identityOf, states, term, rightAgent, pair = false }: {
  messages: readonly AgentMessage[]
  originals: ReadonlyMap<string, AgentMessage>
  name: string
  actor: (id: string) => ReactNode
  identityOf: (id: string) => string
  states: ReadonlyMap<string, MessageState>
  term: string
  rightAgent?: string
  pair?: boolean
}) {
  return (
    <div className="agent-message-thread" role="log" tabIndex={0} aria-label={name}>
      {messages.length === 0 && <p className="form-hint">{term ? '검색에 맞는 메시지가 없습니다.' : '아직 메시지가 없습니다.'}</p>}
      {groupMessages(messages).map(day => (
        <div key={day.label} className="agent-message-day">
          <div className="agent-message-date">{day.label}</div>
          {day.groups.map(group => {
            const outgoing = group.from === rightAgent
            const allAgents = rightAgent === undefined
            return (
              <div key={group.messages[0].id} className="agent-message-group" data-side={outgoing ? 'right' : 'left'} data-sender={group.from}
                style={{ '--agent-bubble-color': group.from === 'user' ? 'var(--text-secondary)' : agentIdentityColor(group.from) } as CSSProperties}>
                <div className="agent-message-group-label">
                  {(pair || allAgents || !outgoing) && actor(group.from)}
                  {!pair && (outgoing || allAgents) && <><RiArrowRightSLine aria-hidden="true" />{actor(group.to)}</>}
                </div>
                {group.messages.map(message => {
                  const original = message.replyTo ? originals.get(message.replyTo) : undefined
                  return <MessageBubble key={message.id} message={message} original={original?.from === message.to && original.to === message.from ? original : undefined}
                    state={states.get(message.id) ?? 'unread'} term={term} name={identityOf(message.from) + ' → ' + identityOf(message.to)} />
                })}
              </div>
            )
          })}
        </div>
      ))}
    </div>
  )
}
