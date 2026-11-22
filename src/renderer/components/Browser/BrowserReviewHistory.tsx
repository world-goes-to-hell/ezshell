import { useId } from 'react'
import { RiArrowRightSLine } from 'react-icons/ri'
import type { AgentMessage } from '../../types'
import { useAgentMessagesStore } from '../Terminal/AgentMessages'

const statusLabels = {
  waiting: '답장 대기',
  seen: '읽음',
  acknowledged: '확인함',
  replied: '답장 도착',
  completed: '완료',
  deferred: '보류'
}

const dateTime = new Intl.DateTimeFormat('ko-KR', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })

export function BrowserReviewHistory() {
  const heading = useId()
  const messages = useAgentMessagesStore(state => state.snapshot.messages)
  const replies = new Map<string, AgentMessage>()
  const requests = []
  for (const message of messages) {
    if (message.to === 'user' && message.replyTo) replies.set(message.replyTo, message)
    if (message.from === 'user' && message.reviewRequest) requests.push({ message, request: message.reviewRequest })
  }

  return (
    <section className="browser-review-history" aria-labelledby={heading}>
      <h2 id={heading}>보낸 요청</h2>
      {requests.length === 0 ? <p className="browser-review-hint">보낸 요청이 없습니다.</p> : (
        <ol>
          {requests.reverse().map(({ message, request }) => {
            const reply = replies.get(message.id)
            const status = reply ? reply.replyStatus ?? 'replied'
              : message.read ? 'acknowledged' : message.seenAt ? 'seen' : 'waiting'

            return (
              <li key={message.id} data-request-id={message.id}>
                <details>
                  <summary>
                    <RiArrowRightSLine className="browser-review-history-chevron" aria-hidden="true" />
                    <span className="browser-review-history-preview">{request.text}</span>
                    <span className="browser-review-history-status" data-status={status}>{statusLabels[status]}</span>
                    <small className="browser-review-history-meta">
                      {message.to} · <time dateTime={new Date(message.sentAt).toISOString()}>{dateTime.format(message.sentAt)}</time>
                    </small>
                  </summary>
                  <div className="browser-review-history-detail">
                    <p>{request.text}</p>
                    <div className="browser-review-history-element">
                      <code>{request.selector}</code>
                      <small>{request.url}</small>
                    </div>
                    {reply && <div className="browser-review-history-reply">
                      <strong>에이전트 답장</strong>
                      <p>{reply.text}</p>
                    </div>}
                  </div>
                </details>
              </li>
            )
          })}
        </ol>
      )}
    </section>
  )
}
