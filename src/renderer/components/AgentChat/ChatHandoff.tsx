import { useContext, useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import { RiArrowLeftSLine, RiArrowRightSLine, RiFolder3Line, RiShareForwardLine } from 'react-icons/ri'
import type { AgentMessageSession } from '../../types'
import { useAgentMessagesStore } from '../Terminal/AgentMessages'
import { AGENT_PROVIDER_ICONS } from '../ui/agentProviderIcons'
import { agentIdentityStatus, localAgentName } from '../../lib/agentIdentity'
import { handoffProjects, selectedHandoffProject } from '../../lib/chatHandoff'
import { toast } from '../../stores/toastStore'
import { HandoffProjectsContext } from './HandoffProjectsContext'
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
 * Hands an answer to another agent: choose its project and agent, add a comment and send. The
 * message goes to that agent's inbox as from the user (main builds it: src/agentChat/handoff.js).
 * Esc closes only this card (in the chat view Esc stops the agent).
 */
export function ChatHandoff({ shellId, answer, source, onClose }: {
  shellId: string; answer: string; source: AgentMessageSession | null; onClose: () => void
}) {
  const agents = useAgentMessagesStore(state => state.snapshot.agents)
  const workProjects = useContext(HandoffProjectsContext)
  const groups = useMemo(() => handoffProjects(agents, source?.id ?? null, source?.cwd ?? null, workProjects),
    [agents, source?.id, source?.cwd, workProjects])
  const [projectKey, setProjectKey] = useState<string | null>(null)
  const project = selectedHandoffProject(groups, projectKey)
  const hasProjects = groups.length > 0
  const canGoBack = Boolean(project && groups.length > 1)
  const [chosen, setChosen] = useState<string | null>(null)
  const [comment, setComment] = useState('')
  const [sending, setSending] = useState(false)
  const [error, setError] = useState<string>()
  const cardRef = useRef<HTMLDivElement>(null)
  const commentRef = useRef<HTMLTextAreaElement>(null)
  const lastProject = useRef<string | null>(null)
  const commentId = useId()
  const listName = useId()
  const selected = project?.agents.find(agent => agent.id === chosen)?.id ?? project?.agents[0]?.id
  const projectSelected = Boolean(project)

  useEffect(() => {
    const card = cardRef.current
    if (!card || document.activeElement === commentRef.current) return
    if (projectSelected) {
      card.querySelector<HTMLInputElement>('input[type="radio"]:checked')?.focus()
    } else if (hasProjects) {
      const rows = [...card.querySelectorAll<HTMLButtonElement>('.agent-chat-handoff-project')]
      const row = rows.find(item => item.dataset.projectKey === lastProject.current) ?? rows[0]
      row?.focus()
    } else {
      commentRef.current?.focus()
    }
  }, [projectSelected, project?.key, hasProjects, selected])

  function goBack() {
    if (!project || !canGoBack) return
    lastProject.current = project.key
    setProjectKey(null)
  }

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
    // The chat view's own shortcuts must not see keys typed in the card.
    event.stopPropagation()
    if (event.key === 'Escape') {
      event.preventDefault()
      onClose()
      return
    }
    if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
      event.preventDefault()
      void send()
      return
    }
    const target = event.target as HTMLElement
    if (canGoBack && (event.key === 'Backspace' || event.key === 'ArrowLeft') && target !== commentRef.current) {
      event.preventDefault()
      goBack()
      return
    }
    if (target instanceof HTMLInputElement && target.type === 'radio' && event.key === 'Enter') {
      event.preventDefault()
      setChosen(target.value)
      commentRef.current?.focus()
      return
    }
    if (target.dataset.projectKey && (event.key === 'ArrowUp' || event.key === 'ArrowDown')) {
      const rows = [...(cardRef.current?.querySelectorAll<HTMLButtonElement>('.agent-chat-handoff-project') ?? [])]
      const step = event.key === 'ArrowDown' ? 1 : -1
      event.preventDefault()
      rows[(rows.indexOf(target as HTMLButtonElement) + step + rows.length) % rows.length]?.focus()
    }
  }

  const preview = answer.length > PREVIEW_CHARS ? `${answer.slice(0, PREVIEW_CHARS)}…` : answer

  return (
    <div className="agent-chat-handoff-backdrop" onPointerDown={event => { if (event.target === event.currentTarget) onClose() }}>
      <div ref={cardRef} className="agent-chat-handoff" role="dialog" aria-modal="true" aria-label="다른 에이전트에게 인계" onKeyDown={onKeyDown}>
        <div className="agent-chat-handoff-title"><RiShareForwardLine aria-hidden /> 다른 에이전트에게 인계</div>
        {!hasProjects ? (
          <p className="agent-chat-handoff-empty">인계할 수 있는 에이전트가 없습니다. 메시지 MCP 가 연결된 다른 에이전트가 있어야 합니다.</p>
        ) : !project ? (
          <div className="agent-chat-handoff-list" role="group" aria-label="받을 프로젝트">
            {groups.map(group => (
              <button type="button" key={group.key} className="agent-chat-handoff-project" data-project-key={group.key}
                title={group.folder ?? group.name} onClick={() => setProjectKey(group.key)}>
                <RiFolder3Line aria-hidden className="agent-chat-handoff-project-icon" />
                <span className="agent-chat-handoff-name">{group.name}</span>
                <span className="agent-chat-handoff-project-count">
                  에이전트 {group.agents.length}명 · <span data-working={group.workingCount > 0 || undefined}>작업 중 {group.workingCount}명</span>
                </span>
                <RiArrowRightSLine aria-hidden />
              </button>
            ))}
          </div>
        ) : (
          <>
            {canGoBack ? (
              <button type="button" className="agent-chat-handoff-project-heading agent-chat-handoff-back"
                aria-label={`${project.name} · 프로젝트 목록으로 돌아가기`} onClick={goBack}>
                <RiArrowLeftSLine aria-hidden /><span className="agent-chat-handoff-name">{project.name}</span>
              </button>
            ) : (
              <div className="agent-chat-handoff-project-heading">
                <RiFolder3Line aria-hidden /><span className="agent-chat-handoff-name">{project.name}</span>
              </div>
            )}
            <div className="agent-chat-handoff-list" role="radiogroup" aria-label={`${project.name}의 받을 에이전트`}>
              {project.agents.map(agent => {
                const Provider = AGENT_PROVIDER_ICONS[agent.kind]
                return (
                  <label key={agent.id} className="agent-chat-handoff-agent" data-selected={agent.id === selected || undefined}>
                    <input type="radio" name={listName} value={agent.id} checked={agent.id === selected} onChange={() => setChosen(agent.id)} />
                    <Provider aria-hidden className="agent-chat-handoff-provider" data-kind={agent.kind} />
                    <span className="agent-chat-handoff-text">
                      <span className="agent-chat-handoff-name">{localAgentName(agent)}</span>
                      <span className="agent-chat-handoff-meta">{agentIdentityStatus(agent).label}</span>
                    </span>
                  </label>
                )
              })}
            </div>
          </>
        )}
        <label className="agent-chat-handoff-label" htmlFor={commentId}>코멘트 (선택)</label>
        <textarea ref={commentRef} id={commentId} className="agent-chat-handoff-comment" value={comment} maxLength={MAX_COMMENT} rows={3}
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
