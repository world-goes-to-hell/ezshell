import { useEffect, useId, useRef, useState, type CSSProperties } from 'react'
import { createPortal } from 'react-dom'
import type { AgentMessageSession } from '../../types'
import { RiArrowRightUpLine, RiPencilLine } from 'react-icons/ri'
import { agentIdentityColor, agentIdentityLabel, agentIdentityTooltip, agentShortName, type AgentPaneLocation } from '../../lib/agentIdentity'
import { AGENT_PROVIDER_ICONS } from './agentProviderIcons'
import './AgentIdentity.css'

export function AgentIdentityDot({ id }: { id: string }) {
  return <span className="agent-identity-dot" style={{ backgroundColor: agentIdentityColor(id) }} aria-hidden="true" />
}

/**
 * `nameOnly`: the role alone when it has one, else the id (the arrival card, 2026-11-25 user request).
 * The tooltip still names both
 */
export function AgentIdentityBadge({ agent, location, showProvider = false, nameOnly = false }: { agent: AgentMessageSession; location?: AgentPaneLocation; showProvider?: boolean; nameOnly?: boolean }) {
  const label = nameOnly ? agentShortName(agent) : agentIdentityLabel(agent)
  const ProviderIcon = AGENT_PROVIDER_ICONS[agent.kind]
  return (
    <span className="agent-identity-badge" {...agentIdentityTooltip(agent, location)} data-agent-id={agent.id}>
      <AgentIdentityDot id={agent.id} />
      {showProvider && <ProviderIcon size={12} aria-hidden="true" />}
      <span>{label}</span>
    </span>
  )
}

export function AgentIdentityAction({ id, action, onClick, showLabel = false }: {
  id: string; action: 'edit' | 'go'; onClick: () => void; showLabel?: boolean
}) {
  const Icon = action === 'edit' ? RiPencilLine : RiArrowRightUpLine
  const label = action === 'edit' ? '역할 편집' : '그 칸으로 가기'
  return (
    <button type="button" className="agent-identity-action" data-action={action} data-show-label={showLabel || undefined}
      title={label} aria-label={`${id} ${label}`} onClick={onClick}>
      <Icon size={14} aria-hidden="true" />
      {showLabel && <span>{label}</span>}
    </button>
  )
}

/**
 * The agent's badge as a button that names it (the chat header, 2026-11-24 user request): the role editor opens
 * in a popover under it, the same one as in the agent message window
 */
export function AgentRoleButton({ agent, location }: { agent: AgentMessageSession; location?: AgentPaneLocation }) {
  const [place, setPlace] = useState<CSSProperties | null>(null)
  const button = useRef<HTMLButtonElement>(null)
  const popover = useRef<HTMLDivElement>(null)
  const close = () => {
    setPlace(null)
    button.current?.focus()
  }
  useEffect(() => {
    if (!place) return
    const outside = (event: PointerEvent) => {
      const target = event.target as Node
      if (!popover.current?.contains(target) && !button.current?.contains(target)) setPlace(null)
    }
    document.addEventListener('pointerdown', outside, true)
    return () => document.removeEventListener('pointerdown', outside, true)
  }, [place])
  const open = () => {
    if (place) return setPlace(null)
    const box = button.current?.getBoundingClientRect()
    if (!box) return
    setPlace({ top: box.bottom + 6, left: Math.max(12, Math.min(box.left, innerWidth - 372)) })
  }
  return (
    <>
      <button ref={button} type="button" className="agent-identity-edit" aria-expanded={Boolean(place)} aria-haspopup="dialog"
        aria-label={`${agentIdentityLabel(agent)} · 눌러서 역할 바꾸기`} onClick={open}>
        <AgentIdentityBadge agent={agent} location={location} />
      </button>
      {place && createPortal(
        <div ref={popover} className="agent-role-popover" role="dialog" aria-label={`${agent.id} 역할`} style={place}>
          <AgentRoleEditor agent={agent} onClose={close} />
        </div>,
        document.body
      )}
    </>
  )
}

/** Name an agent (a role): a user's role wins over the agent's own, and clearing it brings that back */
export function AgentRoleEditor({ agent, onClose }: { agent: AgentMessageSession; onClose: () => void }) {
  const [value, setValue] = useState(agent.role ?? '')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string>()
  const inputId = useId()

  async function save(role: string) {
    if (saving) return
    setSaving(true)
    setError(undefined)
    try {
      const result = await window.electronAPI.agentMessageSetRole?.(agent.id, role)
      if (result?.success) onClose()
      else setError(result?.error ?? '에이전트 역할을 저장할 수 없습니다.')
    } catch {
      setError('에이전트 역할을 저장할 수 없습니다.')
    } finally {
      setSaving(false)
    }
  }

  return (
    <form className="agent-role-editor" onSubmit={event => { event.preventDefault(); void save(value) }}
      onKeyDown={event => {
        // Esc closes only the editor (the chat view would take it as "stop the agent")
        if (event.key !== 'Escape' || event.nativeEvent.isComposing) return
        event.preventDefault()
        event.stopPropagation()
        onClose()
      }}>
      <label htmlFor={inputId}>{agent.id} 역할</label>
      <input id={inputId} value={value} onChange={event => setValue(event.target.value)} autoFocus placeholder="예: 리뷰어" />
      {agent.roleSource === 'user' && <button type="button" className="btn-secondary" disabled={saving} onClick={() => void save('')}>지우기</button>}
      <button type="submit" className="btn-secondary" disabled={saving}>저장</button>
      <button type="button" className="btn-secondary" onClick={onClose}>취소</button>
      {error && <span role="alert">{error}</span>}
    </form>
  )
}
