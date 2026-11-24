// A local shell's agent closed to save memory (src/agentIdle.js), drawn over its pane until it is woken:
// the shell waits for the resume line, so keys must not reach it meanwhile.
import { useEffect, useRef, useState, type MouseEvent } from 'react'
import { APPROVAL_ARM_DELAY_MS } from '../../lib/approvalArming'
import { RiLoader4Line, RiMoonLine, RiTerminalBoxLine } from 'react-icons/ri'
import type { AgentSleep } from '../../types'
import { useAgentSleepStore } from '../../stores/agentSleepStore'
import { toast } from '../../stores/toastStore'
import { useApprovalArming } from './useApprovalArming'
import './AgentSleepCover.css'

const NAMES = { claude: 'Claude', codex: 'Codex' } as const

export function AgentSleepCover({ shellId, onTerminal }: { shellId: string; onTerminal: () => void }) {
  const sleep = useAgentSleepStore(state => state.sleeping.get(shellId))
  if (!sleep) return null
  const name = NAMES[sleep.kind] ?? '에이전트'
  if (sleep.waking) {
    return (
      <div className="agent-sleep-cover" role="status" onMouseDown={event => event.stopPropagation()}>
        <RiLoader4Line className="agent-sleep-icon agent-sleep-spin" aria-hidden />
        <p className="agent-sleep-title">{name} 깨우는 중…</p>
        <p className="agent-sleep-desc">이전 대화를 이어서 불러오고 있습니다.</p>
      </div>
    )
  }
  // A new card for every sleep, so its buttons arm afresh
  return <SleepingCard key={sleep.since} shellId={shellId} sleep={sleep} name={name} onTerminal={onTerminal} />
}

function SleepingCard({ shellId, sleep, name, onTerminal }: { shellId: string; sleep: AgentSleep; name: string; onTerminal: () => void }) {
  const [asking, setAsking] = useState(false)
  const coverRef = useRef<HTMLDivElement>(null)
  const wakeRef = useRef<HTMLButtonElement>(null)
  // The agent falls asleep on its own: an Enter or Space meant for something else must not wake it or
  // give the shell away. The buttons take effect a moment after the card shows and the window has focus
  // (the same rule as the approval cards).
  const { armed, canActivate } = useApprovalArming()
  const [shownAt] = useState(() => Date.now())
  // A pointer press on a card shown for a while is meant (it may also be the click that brings the app
  // forward, which the arming above would ignore): keys still wait for the arming
  const mayPress = (event: MouseEvent) => canActivate() || (event.detail > 0 && Date.now() - shownAt >= APPROVAL_ARM_DELAY_MS)
  const since = new Date(sleep.since).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })

  useEffect(() => {
    // Only when this pane already had the keyboard (its terminal or chat): typing in another pane goes on
    const pane = coverRef.current?.closest('.local-terminal-pane')
    if (pane && document.activeElement instanceof Node && pane.contains(document.activeElement)) wakeRef.current?.focus()
  }, [])

  const wake = async (event: MouseEvent) => {
    if (asking || !mayPress(event)) return
    setAsking(true)
    const result = await window.electronAPI.localShellWake?.(shellId).catch(() => null)
    setAsking(false)
    if (!result?.ok) toast.error(`${name} 를 깨우지 못했습니다.`)
  }

  const keepTerminal = async (event: MouseEvent) => {
    if (!mayPress(event)) return
    const done = await window.electronAPI.localShellStayAwake?.(shellId).catch(() => false)
    if (done) {
      useAgentSleepStore.getState().set(shellId, null)
      onTerminal()
    }
  }

  return (
    <div ref={coverRef} className="agent-sleep-cover" role="status" onMouseDown={event => event.stopPropagation()}>
      <RiMoonLine className="agent-sleep-icon" aria-hidden />
      <p className="agent-sleep-title">{name} 가 잠들어 있습니다</p>
      <p className="agent-sleep-desc">
        {since} 부터 쉬고 있어 메모리를 아끼려고 껐습니다. 깨우면 같은 대화를 이어서 엽니다. 메시지가 오면 저절로 깨어납니다.
      </p>
      <div className="agent-sleep-actions">
        <button ref={wakeRef} type="button" className="agent-sleep-wake" onClick={event => void wake(event)} disabled={asking}
          aria-disabled={!armed || undefined}>깨우기</button>
        <button type="button" className="agent-sleep-terminal" onClick={event => void keepTerminal(event)} aria-disabled={!armed || undefined}
          title="에이전트를 깨우지 않고 이 셸을 터미널로 씁니다">
          <RiTerminalBoxLine aria-hidden /> 터미널로 쓰기
        </button>
      </div>
    </div>
  )
}
