import type { AgentMessageSession } from '../../types'
import { RiArrowRightUpLine, RiPencilLine } from 'react-icons/ri'
import { agentIdentityColor, agentIdentityLabel } from '../../lib/agentIdentity'
import { AGENT_PROVIDER_ICONS, AGENT_PROVIDER_NAMES } from './agentProviderIcons'
import './AgentIdentity.css'

export function AgentIdentityDot({ id }: { id: string }) {
  return <span className="agent-identity-dot" style={{ backgroundColor: agentIdentityColor(id) }} aria-hidden="true" />
}

export function AgentIdentityBadge({ agent, showProvider = false }: { agent: Pick<AgentMessageSession, 'id' | 'role' | 'kind'>; showProvider?: boolean }) {
  const label = agentIdentityLabel(agent)
  const ProviderIcon = AGENT_PROVIDER_ICONS[agent.kind]
  return (
    <span className="agent-identity-badge" title={`${AGENT_PROVIDER_NAMES[agent.kind]} · ${label}`} data-agent-id={agent.id}>
      <AgentIdentityDot id={agent.id} />
      {showProvider && <ProviderIcon size={12} aria-hidden="true" />}
      <span>{label}</span>
    </span>
  )
}

export function AgentIdentityAction({ id, action, onClick }: { id: string; action: 'edit' | 'go'; onClick: () => void }) {
  const Icon = action === 'edit' ? RiPencilLine : RiArrowRightUpLine
  const label = action === 'edit' ? '역할 편집' : '그 칸으로 가기'
  return (
    <button type="button" className="agent-identity-action" data-action={action} title={label} aria-label={`${id} ${label}`} onClick={onClick}>
      <Icon size={14} aria-hidden="true" />
    </button>
  )
}
