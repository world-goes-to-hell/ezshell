import { useEffect, useState, type CSSProperties, type Ref } from 'react'
import * as Tooltip from '@radix-ui/react-tooltip'
import { RiBrainLine } from 'react-icons/ri'
import { useAgentUsageStore } from '../../stores/agentUsageStore'
import { timeLeft, usageLevel, usageSummary } from '../../lib/agentUsageView'
import { shellAgentOf } from '../../lib/agentChatItems'
import type { AgentUsage, AgentUsageWindow } from '../../types'
import { AgentPickerMenu } from './AgentPickerMenu'
import { useAgentMessagesStore, useAgentPaneLocation } from '../Terminal/AgentMessages'
import { AgentIdentityBadge } from '../ui/AgentIdentity'
import './AgentUsage.css'

const TICK_MS = 30_000
const DETAILS_DELAY_MS = 400

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

function UsageDetails({ usage, model, now }: { usage: AgentUsage; model: string; now: number }) {
  const metrics = [
    { label: '5시간 사용량', value: usage.fiveHour },
    { label: '7일 사용량', value: usage.sevenDay },
    { label: '컨텍스트', value: usage.context }
  ]
  return (
    <Tooltip.Portal>
      <Tooltip.Content
        className={`agent-usage-tooltip is-${usage.agent}`}
        side="top"
        align="start"
        sideOffset={6}
        collisionPadding={8}
        aria-label={usageSummary(usage, now)}
      >
        <div className="agent-usage-tooltip-header">
          <strong>{model}</strong>
          {usage.effort && <span className="agent-usage-tooltip-effort">Effort <b>{usage.effort}</b></span>}
        </div>
        <dl className="agent-usage-tooltip-metrics">
          {metrics.map(({ label, value }) => {
            if (!value) return null
            const left = 'resetsAt' in value ? timeLeft(value.resetsAt, now) : null
            return (
              <div key={label} className="agent-usage-tooltip-metric">
                <dt>{label}</dt>
                <dd className={`agent-usage-tooltip-value is-${usageLevel(value.percent)}`}>{value.percent}%</dd>
                {left && <dd className="agent-usage-tooltip-reset">{left} 뒤 초기화</dd>}
              </div>
            )
          })}
        </dl>
      </Tooltip.Content>
    </Tooltip.Portal>
  )
}

/**
 * Model · 5H · 7D · CTX, each a small bar with its percent (and the time left of a window). With a shell,
 * the model and the effort are buttons that change them (AgentPickerMenu).
 */
export function AgentUsageMeters({ usage, now, shellId }: { usage: AgentUsage; now: number; shellId?: string }) {
  const hasMeters = usage.fiveHour || usage.sevenDay || usage.context
  const model = usage.model ?? (usage.agent === 'claude' ? 'Claude' : 'Codex')
  const effort = usage.effort && (
    <>
      <RiBrainLine size={11} aria-hidden="true" />
      <span>{usage.effort}</span>
    </>
  )
  return (
    <>
      <span className={`agent-usage-identity is-${usage.agent}`}>
        {shellId
          ? <AgentPickerMenu shellId={shellId} what="model" kind={usage.agent} current={usage.model} model={usage.model} className="agent-usage-model">{model}</AgentPickerMenu>
          : <span className="agent-usage-model">{model}</span>}
        {effort && (shellId
          ? <AgentPickerMenu shellId={shellId} what="effort" kind={usage.agent} current={usage.effort} model={usage.model} className="agent-usage-effort">{effort}</AgentPickerMenu>
          : <span className="agent-usage-effort">{effort}</span>)}
      </span>
      {hasMeters && (
        <Tooltip.Provider delayDuration={DETAILS_DELAY_MS}>
          <Tooltip.Root>
            <Tooltip.Trigger asChild>
              <span className="agent-usage-meters" tabIndex={0} role="group" aria-label="사용량 상세">
                {usage.fiveHour && <Meter label="5H" value={usage.fiveHour} now={now} />}
                {usage.sevenDay && <Meter label="7D" value={usage.sevenDay} now={now} />}
                {usage.context && <Meter label="CTX" value={{ percent: usage.context.percent }} now={now} />}
              </span>
            </Tooltip.Trigger>
            <UsageDetails usage={usage} model={model} now={now} />
          </Tooltip.Root>
        </Tooltip.Provider>
      )}
    </>
  )
}

/** Below a local terminal: the usage of the agent and any actions from its chat. */
export function AgentPaneUsage({ shellId, actionsRef, showIdentity, style }: { shellId: string | undefined; actionsRef?: Ref<HTMLSpanElement>; showIdentity: boolean; style?: CSSProperties }) {
  const usage = useAgentUsageStore(state => (shellId ? state.byShell.get(shellId) : undefined))
  const agent = useAgentMessagesStore(state => showIdentity && shellId ? shellAgentOf(state.snapshot.agents, shellId) : undefined)
  const location = useAgentPaneLocation(agent)
  const now = useMinuteClock(Boolean(usage))
  if (!usage && !actionsRef && !agent) return null
  return (
    <div className="agent-pane-usage" style={style}>
      {agent && <AgentIdentityBadge agent={agent} location={location} showProvider />}
      {usage && <div className="agent-usage-readout" aria-label={usageSummary(usage, now)} role="status">
        <AgentUsageMeters usage={usage} now={now} shellId={shellId} />
      </div>}
      {actionsRef && <span className="agent-usage-actions" ref={actionsRef} />}
    </div>
  )
}
