import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import { RiShareForwardLine } from 'react-icons/ri'
import type { AgentMessageSession } from '../../types'
import { useAgentMessagesStore } from '../Terminal/AgentMessages'
import { AgentIdentityDot } from '../ui/AgentIdentity'
import { agentIdentityStatus, localAgentName } from '../../lib/agentIdentity'
import { folderNameOf, handoffTargets } from '../../lib/chatHandoff'
import { toast } from '../../stores/toastStore'
import './ChatHandoff.css'

const MAX_COMMENT = 2000
const PREVIEW_CHARS = 600

/** The `인계` button on an answer (next to 답장 and 띄워 두기) */
export function ChatHandoffButton({ onClick }: { onClick: () => void }) {
  return <button type="button" className="agent-chat-quote-reply agent-chat-handoff-button" aria-label="이 답변을 다른 에이전트에게 인계" onClick={onClick}>
    <RiShareForwardLine aria-hidden /> 인계
  </button>
}

/**
 * Hands an answer to another agent: pick one of the connected agents, add a comment, send. The
 * message goes to that agent's inbox as from the user (main builds it: src/agentChat/handoff.js).
 * Esc closes only this card (in the chat view Esc stops the agent).
 */
export function ChatHandoff({ shellId, answer, source, onClose }: {
  shellId: string; answer: string; source: AgentMessageSession | null; onClose: () => void
}) {
  const agents = useAgentMessagesStore(state => state.snapshot.agents)
  const targets = useMemo(() => handoffTargets(agents, source?.id ?? null, source?.cwd ?? null), [agents, source?.id, source?.cwd])
  const [chosen, setChosen] = useState<string | null>(null)
  const [comment, setComment] = useState('')
  const [sending, setSending] = useState(false)
  const [error, setError] = useState<string>()
  const cardRef = useRef<HTMLDivElement>(null)
  const commentId = useId()
  const listName = useId()
  // The first agent until the user picks one; a pick that left the list falls back to the first again
  const selected = targets.some(target => target.agent.id === chosen) ? chosen : targets[0]?.agent.id ?? null

  useEffect(() => {
    cardRef.current?.querySelector<HTMLElement>('input[type="radio"]:checked, textarea')?.focus()
  }, [])

  async function send() {
    if (!selected || sending || !window.electronAPI.agentChatHandoff) return
    setSending(true)
    setError(undefined)
    try {
      const result = await window.electronAPI.agentChatHandoff({ shellId, to: selected, comment, answer })
      if (result.ok) {
        toast.success(`${result.toLabel} 에게 인계했습니다`, '답장은 에이전트 메시지 창에서 볼 수 있습니다.')
        onClose()
        return
      }
      setError(result.error)
    } catch {
      setError('인계하지 못했습니다.')
    } finally {
      setSending(false)
    }
  }

  function onKeyDown(event: KeyboardEvent) {
    if (event.nativeEvent.isComposing) return
    if (event.key === 'Escape') {
      event.preventDefault()
      event.stopPropagation()
      onClose()
    } else if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
      event.preventDefault()
      event.stopPropagation()
      void send()
    } else {
      // The chat view's own keys (shortcuts on the composer) must not see what is typed here
      event.stopPropagation()
    }
  }

  const preview = answer.length > PREVIEW_CHARS ? `${answer.slice(0, PREVIEW_CHARS)}…` : answer

  return (
    <div className="agent-chat-handoff-backdrop" onPointerDown={event => { if (event.target === event.currentTarget) onClose() }}>
      <div ref={cardRef} className="agent-chat-handoff" role="dialog" aria-modal="true" aria-label="다른 에이전트에게 인계" onKeyDown={onKeyDown}>
        <div className="agent-chat-handoff-title"><RiShareForwardLine aria-hidden /> 다른 에이전트에게 인계</div>
        {targets.length === 0 ? (
          <p className="agent-chat-handoff-empty">인계할 수 있는 에이전트가 없습니다. 메시지 MCP 가 연결된 다른 에이전트가 있어야 합니다.</p>
        ) : (
          <div className="agent-chat-handoff-list" role="radiogroup" aria-label="받을 에이전트">
            {targets.map(({ agent, sameProject }) => (
              <label key={agent.id} className="agent-chat-handoff-agent" data-selected={agent.id === selected || undefined}>
                <input type="radio" name={listName} value={agent.id} checked={agent.id === selected} onChange={() => setChosen(agent.id)} />
                <AgentIdentityDot id={agent.id} />
                <span className="agent-chat-handoff-text">
                  <span className="agent-chat-handoff-name">{localAgentName(agent)}</span>
                  <span className="agent-chat-handoff-meta">
                    {agentIdentityStatus(agent).label}
                    {folderNameOf(agent.cwd) && ` · ${folderNameOf(agent.cwd)}`}
                    {sameProject && ' · 같은 프로젝트'}
                  </span>
                </span>
              </label>
            ))}
          </div>
        )}
        <label className="agent-chat-handoff-label" htmlFor={commentId}>코멘트 (선택)</label>
        <textarea id={commentId} className="agent-chat-handoff-comment" value={comment} maxLength={MAX_COMMENT} rows={3}
          placeholder="예: 이 계획으로 구현해 주세요. 끝나면 결과를 알려 주세요." onChange={event => setComment(event.target.value)} />
        <details className="agent-chat-handoff-preview">
          <summary>넘길 답변 보기 ({answer.length.toLocaleString('ko-KR')}자)</summary>
          <pre>{preview}</pre>
        </details>
        {error && <p className="agent-chat-handoff-error" role="alert">{error}</p>}
        <div className="agent-chat-handoff-actions">
          <span className="agent-chat-handoff-hint">Ctrl+Enter 로 인계</span>
          {/* Own button classes: the global .btn-primary is the start screen's large button (sizes differed) */}
          <button type="button" className="agent-chat-handoff-cancel" onClick={onClose}>취소</button>
          <button type="button" className="agent-chat-handoff-send" disabled={!selected || sending} onClick={() => void send()}>
            {sending ? '인계하는 중…' : '인계'}
          </button>
        </div>
      </div>
    </div>
  )
}
