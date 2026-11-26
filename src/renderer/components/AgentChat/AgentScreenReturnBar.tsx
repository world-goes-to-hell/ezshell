// Over a local pane that shows its terminal for a screen a chat slash command opened (`/config` …):
// says the pane goes back to the chat once that screen closes (stores/agentScreenReturnStore.ts).
import { RiChat3Line, RiCloseLine } from 'react-icons/ri'
import { useAgentScreenReturnStore } from '../../stores/agentScreenReturnStore'
import './AgentScreenReturnBar.css'

export function AgentScreenReturnBar({ shellId }: { shellId: string }) {
  const waiting = useAgentScreenReturnStore(state => state.returns.get(shellId))
  const end = useAgentScreenReturnStore(state => state.end)
  if (!waiting) return null
  return (
    <div className="agent-screen-return" role="status" onMouseDown={event => event.preventDefault()}>
      <span>{waiting.continueLogin ? 'Enter를 눌러 Claude 로그인을 마치세요.' : waiting.login
        ? 'Claude 로그인을 완료하면 채팅 보기로 돌아갑니다.'
        : '에이전트 화면을 터미널에서 조작하세요. 화면을 닫으면 채팅 보기로 돌아갑니다.'}</span>
      <button type="button" onClick={() => end(shellId, true)} title="지금 채팅 보기로 돌아가기">
        <RiChat3Line aria-hidden /> 채팅으로
      </button>
      <button type="button" className="agent-screen-return-close" onClick={() => end(shellId, false)} aria-label="터미널에 머물기" title="채팅으로 돌아가지 않고 터미널에 머물기">
        <RiCloseLine aria-hidden />
      </button>
    </div>
  )
}
