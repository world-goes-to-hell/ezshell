import { useEffect, useMemo, useRef, useState } from 'react'
import { RiArrowRightSLine, RiCloseLine, RiSearchLine } from 'react-icons/ri'
import type { AgentChatItem, AgentChatQuestion, AgentChatQuestions as QuestionIndex } from '../../types'

const PAGE_SIZE = 80
const dates = new Intl.DateTimeFormat('ko-KR', { month: 'numeric', day: 'numeric', hour: 'numeric', minute: '2-digit' })

export function AgentChatQuestions({ shellId, scope, items, onPick, onDismiss }: {
  shellId: string
  scope: string | null
  items: AgentChatItem[]
  onPick: (question: AgentChatQuestion) => void
  onDismiss: () => void
}) {
  const [archive, setArchive] = useState<QuestionIndex | null>(null)
  const [error, setError] = useState('')
  const [query, setQuery] = useState('')
  const [limit, setLimit] = useState(PAGE_SIZE)
  const inputRef = useRef<HTMLInputElement>(null)
  const inboxReads = useMemo(() => items.filter(item => item.tool?.isInbox && item.tool.result !== undefined)
    .map(item => item.id).join('\n'), [items])

  useEffect(() => { inputRef.current?.focus() }, [])

  useEffect(() => {
    const read = window.electronAPI.agentChatQuestions
    if (!read) return
    let current = true
    read(shellId).then(result => {
      if (!current) return
      if (result.ok) {
        setArchive(result)
        setError('')
      } else setError(result.error)
    }).catch(() => { if (current) setError('이전 질문 목록을 읽을 수 없습니다.') })
    return () => { current = false }
  }, [shellId, scope, inboxReads])

  const matches = useMemo(() => {
    const saved = archive?.scope === scope ? archive.questions : []
    const recorded = new Set(saved.map(question => question.id))
    const recent = items.filter(item => item.kind === 'user' && !item.inboxNotice && !recorded.has(item.id))
      .map<AgentChatQuestion>(item => ({ id: item.id, time: item.time, text: item.text || '스크린샷 첨부' })).reverse()
    const needle = query.trim().toLocaleLowerCase()
    return [...recent, ...saved].filter(({ text, sender, isReply }) => text.toLocaleLowerCase().includes(needle)
      || (sender && `${receivedMessageLabel(sender, isReply)} ${sender}`.toLocaleLowerCase().includes(needle)))
  }, [archive, items, query, scope])

  const loading = !archive && !error && !!window.electronAPI.agentChatQuestions
  return (
    <section className="agent-chat-questions" aria-label="질문 목록"
      onContextMenu={event => event.stopPropagation()}
      onKeyDown={event => {
        if (event.key === 'Escape') {
          event.stopPropagation()
          onDismiss()
        }
      }}>
      <div className="agent-chat-questions-toolbar">
        <label className="agent-chat-questions-search">
          <RiSearchLine aria-hidden />
          <input ref={inputRef} type="search" value={query} aria-label="질문 검색" placeholder="질문 검색"
            onChange={event => { setQuery(event.target.value); setLimit(PAGE_SIZE) }} />
        </label>
        <button type="button" className="agent-chat-head-btn" aria-label="질문 목록 닫기" title="질문 목록 닫기" onClick={onDismiss}>
          <RiCloseLine size={15} aria-hidden="true" />
        </button>
      </div>
      <div className="agent-chat-questions-results">
        {matches.length > 0 && (
          <ul>
            {matches.slice(0, limit).map(question => (
              <li key={question.id}>
                <button type="button" onClick={() => onPick(question)}>
                  <span className="agent-chat-question-copy">
                    {question.sender && <span className="agent-chat-question-sender">{receivedMessageLabel(question.sender, question.isReply)}</span>}
                    <span className="agent-chat-question-text" title={question.text}>{question.text}</span>
                  </span>
                  <span className="agent-chat-questions-time">{question.time !== null && dates.format(question.time)}</span>
                  <RiArrowRightSLine aria-hidden />
                </button>
              </li>
            ))}
          </ul>
        )}
        {matches.length > limit && (
          <button className="agent-chat-older" type="button" onClick={() => setLimit(count => count + PAGE_SIZE)}>질문 더 보기</button>
        )}
        {!matches.length && (
          <p className="agent-chat-questions-note" role="status">
            {loading ? '질문을 불러오는 중…' : query.trim() ? '검색 결과가 없습니다.' : '아직 질문이 없습니다.'}
          </p>
        )}
        {error && <p className="agent-chat-questions-note" role="status">{error}</p>}
        {archive?.limited && <p className="agent-chat-questions-note">최근 질문 10,000개를 표시합니다.</p>}
      </div>
    </section>
  )
}
export function receivedMessageLabel(sender: string, isReply = false) {
  const [provider, number] = sender.split('-')
  return `${isReply ? '받은 답장' : '받은 작업'} · ${provider === 'codex' ? 'Codex' : 'Claude'} ${number}`
}
