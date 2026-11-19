import { useEffect, useState } from 'react'
import { RiBrainLine } from 'react-icons/ri'
import { useAgentUsageStore } from '../../stores/agentUsageStore'
import { timeLeft, usageLevel, usageSummary } from '../../lib/agentUsageView'
import type { AgentUsage, AgentUsageWindow } from '../../types'
import './AgentUsage.css'

const TICK_MS = 30_000

/** Hears the main process's usage reports; mounted once (the status bar), draws nothing */
export function AgentUsageFeed() {
  const apply = useAgentUsageStore(state => state.apply)
  const reset = useAgentUsageStore(state => state.reset)
  useEffect(() => {
    const api = window.electronAPI
    if (typeof api?.onAgentUsage !== 'function') return
    const off = api.onAgentUsage(apply)
    void api.agentUsageState?.().then(reset, () => {})
    return off
  }, [apply, reset])
  return null
}

/** The time now, again every half minute: the "time left" of the windows moves */
export function useMinuteClock(active: boolean): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!active) return
    setNow(Date.now())
    const timer = setInterval(() => setNow(Date.now()), TICK_MS)
    return () => clearInterval(timer)
  }, [active])
  return now
}

function Meter({ label, value, now }: { label: string; value: AgentUsageWindow | { percent: number; resetsAt?: null }; now: number }) {
  const left = 'resetsAt' in value ? timeLeft(value.resetsAt ?? null, now) : null
  return (
    <span className={`agent-usage-meter is-${usageLevel(value.percent)}`}>
      <span className="agent-usage-label">{label}</span>
      <span className="agent-usage-bar" aria-hidden="true"><span style={{ width: `${Math.min(100, value.percent)}%` }} /></span>
      <span className="agent-usage-percent">{Math.round(value.percent)}%</span>
      {left && <span className="agent-usage-left">{left}</span>}
    </span>
  )
}

/** Model · 5H · 7D · CTX, each a small bar with its percent (and the time left of a window) */
export function AgentUsageMeters({ usage, now }: { usage: AgentUsage; now: number }) {
  const hasMeters = usage.fiveHour || usage.sevenDay || usage.context
  return (
    <>
      <span className={`agent-usage-identity is-${usage.agent}`}>
        <span className="agent-usage-model">{usage.model ?? (usage.agent === 'claude' ? 'Claude' : 'Codex')}</span>
        {usage.effort && (
          <span className="agent-usage-effort">
            <RiBrainLine size={11} aria-hidden="true" />
            <span>{usage.effort}</span>
          </span>
        )}
      </span>
      {hasMeters && (
        <span className="agent-usage-meters">
          {usage.fiveHour && <Meter label="5H" value={usage.fiveHour} now={now} />}
          {usage.sevenDay && <Meter label="7D" value={usage.sevenDay} now={now} />}
          {usage.context && <Meter label="CTX" value={{ percent: usage.context.percent }} now={now} />}
        </span>
      )}
    </>
  )
}

/** Below a local terminal: the usage of the agent running in that shell, or nothing */
export function AgentPaneUsage({ shellId }: { shellId: string | undefined }) {
  const usage = useAgentUsageStore(state => (shellId ? state.byShell.get(shellId) : undefined))
  const now = useMinuteClock(Boolean(usage))
  if (!usage) return null
  const summary = usageSummary(usage, now)
  return (
    <div className="agent-pane-usage" title={summary} aria-label={summary} role="status">
      <AgentUsageMeters usage={usage} now={now} />
    </div>
  )
}
