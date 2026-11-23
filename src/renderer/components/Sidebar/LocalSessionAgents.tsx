import {
  RiChat1Line, RiCircleLine,
  RiErrorWarningLine, RiHourglassLine, RiPlayCircleLine, RiRecordCircleLine, RiStopCircleLine, RiMoonLine, RiTimeLine
} from 'react-icons/ri'
import { agentIdentityLabel } from '../../lib/agentIdentity'
import { focusTabPane } from '../../lib/paneFocus'
import { MAIN_PANE } from '../../lib/splitTree'
import { tabHost } from '../../lib/tabHosts'
import { useTerminalStore } from '../../stores/terminalStore'
import type { AgentMessageSession, LocalAgentStatus } from '../../types'
import { isAgentWorking, useAgentMessagesStore } from '../Terminal/AgentMessages'
import { AgentIdentityDot } from '../ui/AgentIdentity'
import { AGENT_PROVIDER_ICONS, AGENT_PROVIDER_NAMES } from '../ui/agentProviderIcons'

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

export function localAgentAppearance(agent: AgentMessageSession) {
  const status = agent.waitingForReply && ['working', 'idle', 'unknown'].includes(agent.status) ? 'reply' : agent.status
  const { label, Icon } = presentation[status]
  const ProviderIcon = AGENT_PROVIDER_ICONS[agent.kind]
  const name = `${AGENT_PROVIDER_NAMES[agent.kind]} ${agent.id.slice(agent.kind.length + 1)}`
  const statusDescription = `${label}${status === 'error' && agent.exitCode ? ` (종료 코드 ${agent.exitCode})` : ''}`
  const description = `${name} · ${statusDescription}`
  const icons = (
    <span className="local-agent-icons" data-status={status} data-agent-kind={agent.kind} aria-hidden>
      <Icon className="local-agent-status" size={12} />
      <ProviderIcon className="local-agent-provider" size={14} />
    </span>
  )
  return { status, name, label, description, statusDescription, icons }
}

export function LocalSessionAgents({ tabId }: { tabId: string }) {
  const agents = useAgentMessagesStore(state => state.snapshot.agents)
  const paneTabs = useAgentMessagesStore(state => state.panes)
  const focusTerminal = useTerminalStore(state => state.focusTerminal)
  const sessionAgents = agents.filter(agent => paneTabs[agent.shellId] === tabId)
  if (sessionAgents.length === 0) return null

  return (
    <div className="local-agent-strip" role="group" aria-label="이 세션의 에이전트">
      {sessionAgents.map(agent => {
        const { status, statusDescription, icons } = localAgentAppearance(agent)
        const description = `${agentIdentityLabel(agent)} · ${statusDescription}`
        return (
          <button
            key={agent.id}
            type="button"
            className="local-agent-chip"
            data-agent-id={agent.id}
            data-agent-kind={agent.kind}
            data-agent-work={isAgentWorking(agent) ? 'working' : 'idle'}
            data-status={status}
            title={description}
            aria-label={description}
            onClick={() => {
              const pane = tabHost(tabId).querySelector<HTMLElement>(`[data-local-shell-id="${CSS.escape(agent.shellId)}"]`)
              focusTabPane(focusTerminal, tabId, pane?.dataset.pane ?? MAIN_PANE)
            }}
          >
            <AgentIdentityDot id={agent.id} />
            {icons}
          </button>
        )
      })}
    </div>
  )
}
