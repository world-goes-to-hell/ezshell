import {
  RiChat1Line, RiCircleLine, RiOpenaiLine,
  RiErrorWarningLine, RiHourglassLine, RiPlayCircleLine, RiRecordCircleLine, RiStopCircleLine, RiTimeLine
} from 'react-icons/ri'
import { SiClaude } from 'react-icons/si'
import { focusTabPane } from '../../lib/paneFocus'
import { MAIN_PANE } from '../../lib/splitTree'
import { tabHost } from '../../lib/tabHosts'
import { useTerminalStore } from '../../stores/terminalStore'
import type { AgentMessageSession, LocalAgentStatus } from '../../types'
import { useAgentMessagesStore } from '../Terminal/AgentMessages'

const presentation = {
  unknown: { label: '상태 미확인', Icon: RiCircleLine },
  starting: { label: '시작 중', Icon: RiHourglassLine },
  idle: { label: '대기', Icon: RiRecordCircleLine },
  working: { label: '작업 중', Icon: RiPlayCircleLine },
  blocked: { label: '응답 필요', Icon: RiChat1Line },
  reply: { label: '답장 대기', Icon: RiTimeLine },
  error: { label: '오류', Icon: RiErrorWarningLine },
  ended: { label: '종료', Icon: RiStopCircleLine }
} satisfies Record<LocalAgentStatus | 'reply', { label: string; Icon: typeof RiCircleLine }>

/** The icon of each agent program, shared by the sidebar and the agent history panel */
export const AGENT_PROVIDER_ICONS = { codex: RiOpenaiLine, claude: SiClaude } as const

export function localAgentAppearance(agent: AgentMessageSession) {
  const status = agent.waitingForReply && ['working', 'idle', 'unknown'].includes(agent.status) ? 'reply' : agent.status
  const { label, Icon } = presentation[status]
  const ProviderIcon = AGENT_PROVIDER_ICONS[agent.kind === 'codex' ? 'codex' : 'claude']
  const name = `${agent.kind === 'codex' ? 'Codex' : 'Claude Code'} ${agent.id.slice(agent.kind.length + 1)}`
  const description = `${name} · ${label}${status === 'error' && agent.exitCode ? ` (종료 코드 ${agent.exitCode})` : ''}`
  const icons = (
    <span className="local-agent-icons" data-status={status} data-agent-kind={agent.kind} aria-hidden>
      <Icon className="local-agent-status" size={12} />
      <ProviderIcon className="local-agent-provider" size={14} />
    </span>
  )
  return { status, label, description, icons }
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
        const { status, description, icons } = localAgentAppearance(agent)
        return (
          <button
            key={agent.id}
            type="button"
            className="local-agent-chip"
            data-agent-id={agent.id}
            data-agent-kind={agent.kind}
            data-status={status}
            title={description}
            aria-label={description}
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
