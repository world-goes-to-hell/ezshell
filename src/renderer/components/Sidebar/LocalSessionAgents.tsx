import { FaExclamation } from 'react-icons/fa'
import {
  RiChat1Line, RiCircleLine,
  RiErrorWarningLine, RiHourglassLine, RiPlayCircleLine, RiPlayFill, RiRecordCircleLine, RiStopCircleLine, RiMoonLine, RiTimeLine
} from 'react-icons/ri'
import { agentIdentityColor, agentIdentityStatus, agentIdentityTooltip, localAgentName, messagesUnreachable } from '../../lib/agentIdentity'
import { localAgentPaneLocation } from '../../lib/localPaneShells'
import { focusTabPane } from '../../lib/paneFocus'
import { MAIN_PANE } from '../../lib/splitTree'
import { tabHost } from '../../lib/tabHosts'
import { useTerminalStore } from '../../stores/terminalStore'
import type { AgentMessageSession, LocalAgentStatus } from '../../types'
import { isAgentWorking, useAgentMessagesStore } from '../Terminal/AgentMessages'
import { AGENT_PROVIDER_ICONS } from '../ui/agentProviderIcons'

const presentation = {
  unknown: { label: '상태 미확인', Icon: RiCircleLine },
  starting: { label: '시작 중', Icon: RiHourglassLine },
  idle: { label: '대기', Icon: RiRecordCircleLine },
  working: { label: '작업 중', Icon: RiPlayCircleLine },
  blocked: { label: '응답 필요', Icon: RiChat1Line },
  reply: { label: '답장 대기', Icon: RiTimeLine },
  error: { label: '오류', Icon: RiErrorWarningLine },
  ended: { label: '종료', Icon: RiStopCircleLine },
  sleeping: { label: '잠듦', Icon: RiMoonLine }
} satisfies Record<LocalAgentStatus | 'reply', { label: string; Icon: typeof RiCircleLine }>

const compactIcons: Partial<Record<LocalAgentStatus | 'reply', typeof RiCircleLine>> = {
  working: RiPlayFill,
  blocked: FaExclamation
}

export function localAgentAppearance(agent: AgentMessageSession, { compact = false } = {}) {
  const { status } = agentIdentityStatus(agent)
  const { label, Icon: DefaultIcon } = presentation[status]
  const Icon = (compact && compactIcons[status]) || DefaultIcon
  const ProviderIcon = AGENT_PROVIDER_ICONS[agent.kind]
  // With the role the user or agent gave it (에이전트 메시지 · 채팅 머리줄에서 바꿈)
  const name = localAgentName(agent)
  const statusDescription = `${label}${status === 'error' && agent.exitCode ? ` (종료 코드 ${agent.exitCode})` : ''}`
  const description = `${name} · ${statusDescription}`
  const color = compact ? { color: agentIdentityColor(agent.id) } : undefined
  const mark = compact && status === 'idle'
    ? <span className="local-agent-status local-agent-status-dot" style={color} />
    : <Icon className="local-agent-status" size={12} style={color} />
  const provider = <ProviderIcon className="local-agent-provider" size={14} />
  const icons = (
    <span className="local-agent-icons" data-status={status} data-agent-kind={agent.kind} aria-hidden>
      {compact ? <>{provider}{mark}</> : <>{mark}{provider}</>}
    </span>
  )
  return { status, name, label, description, icons }
}

export function LocalSessionAgents({ tabId }: { tabId: string }) {
  const agents = useAgentMessagesStore(state => state.snapshot.agents)
  const paneTabs = useAgentMessagesStore(state => state.panes)
  const tab = useTerminalStore(state => state.terminals.get(tabId))
  const focusTerminal = useTerminalStore(state => state.focusTerminal)
  const sessionAgents = agents.filter(agent => paneTabs[agent.shellId] === tabId)
  if (sessionAgents.length === 0) return null

  return (
    <div className="local-agent-strip" role="group" aria-label="이 세션의 에이전트">
      {sessionAgents.map(agent => {
        const { status, icons } = localAgentAppearance(agent, { compact: true })
        const tooltip = agentIdentityTooltip(agent, localAgentPaneLocation(tab, agent))
        return (
          <button
            key={agent.id}
            type="button"
            className="local-agent-chip"
            data-agent-id={agent.id}
            data-agent-kind={agent.kind}
            data-agent-work={isAgentWorking(agent) ? 'working' : 'idle'}
            data-status={status}
            data-messages={messagesUnreachable(agent) ? 'unreachable' : undefined}
            {...tooltip}
            aria-label={tooltip.title.replace(/\n/g, ', ')}
            onClick={() => {
              const pane = tabHost(tabId).querySelector<HTMLElement>(`[data-local-shell-id="${CSS.escape(agent.shellId)}"]`)
              focusTabPane(focusTerminal, tabId, pane?.dataset.pane ?? MAIN_PANE)
            }}
          >
            {icons}
          </button>
        )
      })}
    </div>
  )
}
