// A local shell's agent closed to save memory (src/agentIdle.js), drawn over its pane until it is woken:
// the shell waits for the resume line, so keys must not reach it meanwhile.
import { useEffect, useRef, useState } from 'react'
import { RiLoader4Line, RiMoonLine, RiTerminalBoxLine } from 'react-icons/ri'
import { useAgentSleepStore } from '../../stores/agentSleepStore'
import { toast } from '../../stores/toastStore'
import './AgentSleepCover.css'

const NAMES = { claude: 'Claude', codex: 'Codex' } as const

export function AgentSleepCover({ shellId, onTerminal }: { shellId: string; onTerminal: () => void }) {
  const sleep = useAgentSleepStore(state => state.sleeping.get(shellId))
  const [asking, setAsking] = useState(false)
  const wakeRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    if (sleep && !sleep.waking) wakeRef.current?.focus()
  }, [sleep])

  if (!sleep) return null
  const name = NAMES[sleep.kind] ?? '에이전트'
  const since = new Date(sleep.since).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })

  const wake = async () => {
    if (asking) return
    setAsking(true)
    const result = await window.electronAPI.localShellWake?.(shellId).catch(() => null)
    setAsking(false)
    if (!result?.ok) toast.error(`${name} 를 깨우지 못했습니다.`)
  }

  const keepTerminal = async () => {
    const done = await window.electronAPI.localShellStayAwake?.(shellId).catch(() => false)
    if (done) {
      useAgentSleepStore.getState().set(shellId, null)
      onTerminal()
    }
  }

  return (
    <div className="agent-sleep-cover" role="status" onMouseDown={event => event.stopPropagation()}>
      {sleep.waking ? (
        <>
          <RiLoader4Line className="agent-sleep-icon agent-sleep-spin" aria-hidden />
          <p className="agent-sleep-title">{name} 깨우는 중…</p>
          <p className="agent-sleep-desc">이전 대화를 이어서 불러오고 있습니다.</p>
        </>
      ) : (
        <>
          <RiMoonLine className="agent-sleep-icon" aria-hidden />
          <p className="agent-sleep-title">{name} 가 잠들어 있습니다</p>
          <p className="agent-sleep-desc">
            {since} 부터 쉬고 있어 메모리를 아끼려고 껐습니다. 깨우면 같은 대화를 이어서 엽니다. 메시지가 오면 저절로 깨어납니다.
          </p>
          <div className="agent-sleep-actions">
            <button ref={wakeRef} type="button" className="agent-sleep-wake" onClick={() => void wake()} disabled={asking}>깨우기</button>
            <button type="button" className="agent-sleep-terminal" onClick={() => void keepTerminal()} title="에이전트를 깨우지 않고 이 셸을 터미널로 씁니다">
              <RiTerminalBoxLine aria-hidden /> 터미널로 쓰기
            </button>
          </div>
        </>
      )}
    </div>
  )
}
