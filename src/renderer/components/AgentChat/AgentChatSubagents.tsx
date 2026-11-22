import { useEffect, useId, useLayoutEffect, useRef, useState, type CSSProperties } from 'react'
import { createPortal } from 'react-dom'
import { RiArrowRightSLine, RiGitBranchLine } from 'react-icons/ri'
import { readSubagentActivity, subagentDisplayText, type SubagentActivityResult } from '../../lib/agentChatItems'
import { placeTooltip } from '../../lib/tooltipPosition'
import type { AgentChatSubagent } from '../../types'

type Status = AgentChatSubagent['status']

const LABELS: Record<Status, string> = {
  starting: '시작 중',
  running: '작업 중',
  completed: '완료',
  error: '오류',
  stopped: '중단',
  unknown: '상태 미확인'
}
const STATUSES: Status[] = ['running', 'starting', 'completed', 'error', 'stopped', 'unknown']
const active = (status: Status) => status === 'starting' || status === 'running'

function elapsed(start: number | null, end: number | null) {
  if (start === null || end === null || end < start) return null
  const seconds = Math.floor((end - start) / 1000)
  if (seconds < 60) return `${seconds}초`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}분 ${seconds % 60}초`
  return `${Math.floor(minutes / 60)}시간 ${minutes % 60}분`
}

interface PreviewTarget {
  id: string
  anchor: HTMLButtonElement
}

function SubagentPreview({ shellId, agent, status, anchor, id, stay, closeSoon, themeStyle }: {
  shellId: string
  agent: AgentChatSubagent
  status: Status
  anchor: HTMLButtonElement
  id: string
  stay: () => void
  closeSoon: () => void
  themeStyle?: CSSProperties
}) {
  const ref = useRef<HTMLDivElement>(null)
  const [activity, setActivity] = useState<SubagentActivityResult | null>(null)
  const [position, setPosition] = useState<{ left: number; top: number } | null>(null)
  const following = active(status)
  const resultText = agent.result.replace(/\s+/g, ' ').trim()
  const recent = Array.isArray(activity) ? activity.filter(item => item.label !== '응답' || item.detail !== resultText) : []
  const activityLabel = activity === 'restart-required' ? '최근 작업을 보려면 ezShell을 다시 시작해 주세요.'
    : activity === 'unavailable' ? '작업 기록을 읽지 못했습니다.'
      : activity === null ? '작업 기록 확인 중…' : following ? '작업 기록 대기 중' : '표시할 활동 기록 없음'

  useEffect(() => {
    let cancelled = false
    let timer: number | undefined
    async function refresh() {
      const items = await readSubagentActivity(window.electronAPI.agentChatSubagentPreview, shellId, agent.id)
      if (cancelled) return
      setActivity(items)
      if (following && items !== 'restart-required') timer = window.setTimeout(() => void refresh(), 1500)
    }
    void refresh()
    return () => { cancelled = true; window.clearTimeout(timer) }
  }, [shellId, agent.id, following])

  useLayoutEffect(() => {
    const panel = ref.current
    if (!panel) return
    const place = () => {
      const rect = anchor.getBoundingClientRect()
      const list = anchor.closest('.agent-chat-subagents-list')?.getBoundingClientRect()
      if (!rect.height || (list && (rect.bottom <= list.top || rect.top >= list.bottom))) {
        setPosition(null)
        return
      }
      const { left, top } = placeTooltip(rect, { width: panel.offsetWidth, height: panel.offsetHeight }, {
        width: window.innerWidth, height: window.innerHeight
      })
      setPosition({ left, top })
    }
    place()
    const observer = new ResizeObserver(place)
    observer.observe(panel)
    observer.observe(anchor)
    window.addEventListener('resize', place)
    window.addEventListener('scroll', place, true)
    return () => {
      observer.disconnect()
      window.removeEventListener('resize', place)
      window.removeEventListener('scroll', place, true)
    }
  }, [anchor])

  return createPortal(
    <div ref={ref} id={id} className="agent-chat-subagent-preview" role="region"
      aria-label={`${agent.name || '서브에이전트'} 최근 작업`} tabIndex={0}
      style={{ ...themeStyle, ...(position ?? { visibility: 'hidden' }) }}
      onPointerEnter={stay} onPointerLeave={closeSoon} onFocus={stay} onBlur={closeSoon}
      onContextMenu={event => event.stopPropagation()}>
      <div className="agent-chat-subagent-preview-head">
        <strong>{agent.name || '서브에이전트'}</strong>
        <span data-status={status}>{LABELS[status]}</span>
      </div>
      {agent.task && <p className="agent-chat-subagent-preview-task">{agent.task}</p>}
      {recent.length > 0 && <>
        <h3>최근 작업</h3>
        <ul>
          {recent.map(({ label, detail }) => <li key={JSON.stringify([label, detail])}>
            <strong>{label}</strong>{detail && <span>{detail}</span>}
          </li>)}
        </ul>
      </>}
      {!recent.length && (!agent.result || typeof activity === 'string') && <p className="agent-chat-subagent-preview-empty">{activityLabel}</p>}
      {agent.result && <>
        <h3>결과</h3>
        <p className="agent-chat-subagents-result">{agent.result}</p>
      </>}
    </div>,
    document.body
  )
}

export function AgentChatSubagents({ shellId, kind, agents, live, onOpen, themeStyle }: {
  shellId: string; kind: 'claude' | 'codex' | null; agents: AgentChatSubagent[]; live: boolean; onOpen: (id: string) => void
  themeStyle?: CSSProperties
}) {
  const [expanded, setExpanded] = useState(false)
  const [now, setNow] = useState(Date.now)
  const [target, setTarget] = useState<PreviewTarget | null>(null)
  const timer = useRef<number | undefined>(undefined)
  const previewId = useId()
  const selected = expanded && target ? agents.find(agent => agent.id === target.id) : undefined
  const stay = () => window.clearTimeout(timer.current)
  const close = () => { stay(); setTarget(null) }
  const closeSoon = () => { stay(); timer.current = window.setTimeout(close, 220) }
  const openSoon = (id: string, anchor: HTMLButtonElement) => {
    stay()
    timer.current = window.setTimeout(() => setTarget({ id, anchor }), 180)
  }
  const counts = { starting: 0, running: 0, completed: 0, error: 0, stopped: 0, unknown: 0 }
  const visibleStatus = (status: Status) => !live && active(status) ? 'unknown' : status
  for (const agent of agents) counts[visibleStatus(agent.status)]++
  const ticking = expanded && (counts.starting > 0 || counts.running > 0)

  useEffect(() => {
    if (!ticking) return
    const timer = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [ticking])

  useEffect(() => {
    const dismiss = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      window.clearTimeout(timer.current)
      setTarget(null)
    }
    document.addEventListener('keydown', dismiss)
    return () => {
      document.removeEventListener('keydown', dismiss)
      window.clearTimeout(timer.current)
    }
  }, [])

  return (
    <details className="agent-chat-subagents" onToggle={event => {
      setExpanded(event.currentTarget.open)
      if (event.currentTarget.open) setNow(Date.now())
      else close()
    }}>
      <summary>
        <RiGitBranchLine aria-hidden />
        <span className="agent-chat-subagents-total">서브에이전트 {agents.length}개</span>
        <span className="agent-chat-subagents-counts" aria-live="polite">
          {STATUSES.filter(status => counts[status]).map(status => (
            <span key={status} data-status={status}>{LABELS[status]} {counts[status]}</span>
          ))}
        </span>
        <RiArrowRightSLine className="agent-chat-subagents-arrow" aria-hidden />
      </summary>
      <ul className="agent-chat-subagents-list">
        {agents.map(agent => {
          const status = visibleStatus(agent.status)
          const duration = elapsed(agent.startedAt, active(status) ? now : agent.finishedAt)
          const showing = selected?.id === agent.id
          const task = subagentDisplayText(agent.task, kind)
          return (
            <li key={agent.id}>
              <button type="button" className="agent-chat-subagents-entry"
                aria-expanded={showing} aria-controls={showing ? previewId : undefined}
                title="서브에이전트 대화 열기"
                onPointerEnter={event => openSoon(agent.id, event.currentTarget)}
                onPointerLeave={closeSoon} onBlur={closeSoon}
                onClick={() => { close(); onOpen(agent.id) }}>
                <span className="agent-chat-subagents-row">
                  <strong>{agent.name || '서브에이전트'}</strong>
                  <span className="agent-chat-subagents-state" data-status={status}>{LABELS[status]}</span>
                  {duration && <span className="agent-chat-subagents-time">{duration}</span>}
                </span>
                {task && <span className="agent-chat-subagents-task">{task}</span>}
              </button>
            </li>
          )
        })}
      </ul>
      {selected && target && <SubagentPreview key={selected.id} id={previewId} shellId={shellId} themeStyle={themeStyle}
        agent={{ ...selected, task: subagentDisplayText(selected.task, kind), result: subagentDisplayText(selected.result, kind) }}
        status={visibleStatus(selected.status)} anchor={target.anchor} stay={stay} closeSoon={closeSoon} />}
    </details>
  )
}
