import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react'
import { RiCloseLine, RiReplyLine } from 'react-icons/ri'
import { splitQuotedReply } from '../../lib/chatQuote'
import { renderChatMarkdown } from '../../lib/markdownRender'
import './ChatQuote.css'

type SelectionPosition = { text: string; x: number; y: number }

export function ChatQuoteReply({ onClick }: { onClick: () => void }) {
  return <button type="button" className="agent-chat-quote-reply" aria-label="이 답변에 답장" onClick={onClick}>
    <RiReplyLine aria-hidden /> 답장
  </button>
}

function answerOf(node: Node): Element | null {
  const element = node instanceof Element ? node : node.parentElement
  return element?.closest('.agent-chat-assistant > .agent-chat-md') ?? null
}

export function ChatQuoteSelection({ coverRef, logRef, enabled, onQuote }: {
  coverRef: RefObject<HTMLDivElement | null>
  logRef: RefObject<HTMLDivElement | null>
  enabled: boolean
  onQuote: (text: string) => void
}) {
  const [position, setPosition] = useState<SelectionPosition | null>(null)
  useEffect(() => {
    if (!enabled) return
    const update = () => {
      const selection = window.getSelection()
      const log = logRef.current
      const cover = coverRef.current
      if (!selection?.rangeCount || selection.isCollapsed || !log || !cover) return setPosition(null)
      const range = selection.getRangeAt(0)
      const answer = answerOf(range.startContainer)
      if (!answer || !log.contains(answer) || answer !== answerOf(range.endContainer)) return setPosition(null)

      const bounds = log.getBoundingClientRect()
      const rect = Array.from(range.getClientRects()).reverse().find(rect => rect.width > 0 &&
        rect.bottom > bounds.top && rect.top < bounds.bottom && rect.right > bounds.left && rect.left < bounds.right)
      const text = selection.toString().trim()
      if (!rect || !text) return setPosition(null)
      const pane = cover.getBoundingClientRect()
      const x = Math.max(4, Math.min(rect.left - pane.left, pane.width - 113))
      const y = (rect.bottom + 32 <= bounds.bottom ? rect.bottom + 4 : Math.max(bounds.top, rect.top - 30)) - pane.top
      setPosition({ text, x, y })
    }
    document.addEventListener('selectionchange', update)
    document.addEventListener('scroll', update, true)
    window.addEventListener('resize', update)
    update()
    return () => {
      document.removeEventListener('selectionchange', update)
      document.removeEventListener('scroll', update, true)
      window.removeEventListener('resize', update)
    }
  }, [coverRef, enabled, logRef])

  if (!enabled || !position) return null
  return <button type="button" className="agent-chat-quote-selection" style={{ left: position.x, top: position.y }}
    onMouseDown={event => event.preventDefault()}
    onClick={() => {
      window.getSelection()?.removeAllRanges()
      setPosition(null)
      onQuote(position.text)
    }}>
    <RiReplyLine aria-hidden /> 인용해서 답장
  </button>
}

export type ChatQuote = { id: number; text: string }

function QuoteCard({ quote, disabled, onRemove }: { quote: ChatQuote; disabled: boolean; onRemove: () => void }) {
  const [expanded, setExpanded] = useState(false)
  const [overflow, setOverflow] = useState(false)
  const preview = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    const element = preview.current
    if (expanded || !element) return
    const measure = () => setOverflow(element.scrollHeight > element.clientHeight)
    const observer = new ResizeObserver(measure)
    measure()
    observer.observe(element)
    return () => observer.disconnect()
  }, [expanded, quote.text])

  return <div className="agent-chat-quote-card">
    <div className="agent-chat-quote-preview" ref={preview} data-expanded={expanded}>{quote.text}</div>
    {overflow && <button type="button" className="agent-chat-quote-toggle" aria-expanded={expanded}
      onClick={() => setExpanded(value => !value)}>{expanded ? '접기' : '펼치기'}</button>}
    <button type="button" className="agent-chat-quote-remove" title="인용 제거" aria-label="인용 제거" disabled={disabled} onClick={onRemove}>
      <RiCloseLine aria-hidden />
    </button>
  </div>
}

export function ChatQuoteCards({ quotes, disabled, onRemove, notice }: {
  quotes: readonly ChatQuote[]
  disabled: boolean
  onRemove: (id: number) => void
  notice?: string
}) {
  if (!quotes.length) return null
  return <div className="agent-chat-quotes">
    <div className="agent-chat-quote-list" role="group" aria-label="답장에 넣을 인용">
      {quotes.map(quote => <QuoteCard key={quote.id} quote={quote} disabled={disabled} onRemove={() => onRemove(quote.id)} />)}
    </div>
    {notice && <div className="agent-chat-quote-notice" role="status">{notice}</div>}
  </div>
}

export function QuotedChatMessage({ text }: { text: string }) {
  const reply = splitQuotedReply(text)
  if (!reply) return text
  return <>
    <div className="agent-chat-quote-markdown">
      {reply.quotes.map((quote, index) => (
        // Markdown uses html: false and the chat's existing link checks.
        <div key={index} className="agent-chat-md agent-chat-sent-quote" dangerouslySetInnerHTML={{ __html: renderChatMarkdown(quote) }} />
      ))}
    </div>
    {reply.body}
  </>
}
