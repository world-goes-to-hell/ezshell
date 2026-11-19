import type { AgentUsage } from '../types'

export type UsageLevel = 'ok' | 'warn' | 'high'

/** Yellow from 70%, red from 90% */
export function usageLevel(percent: number): UsageLevel {
  if (percent >= 90) return 'high'
  if (percent >= 70) return 'warn'
  return 'ok'
}

/** Time until a window resets: `2h10m`, `3d4h`, `45m`; null when unknown or passed */
export function timeLeft(resetsAt: number | null, now: number): string | null {
  if (resetsAt === null) return null
  const minutes = Math.floor((resetsAt - now) / 60_000)
  if (minutes < 0) return null
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h${String(minutes % 60).padStart(2, '0')}m`
  return `${Math.floor(hours / 24)}d${hours % 24}h`
}

/** One line for the tooltip, also what a screen reader reads */
export function usageSummary(usage: AgentUsage, now: number): string {
  const name = usage.model ?? (usage.agent === 'claude' ? 'Claude' : 'Codex')
  const parts = [usage.effort ? `${name} (effort ${usage.effort})` : name]
  const window = (label: string, value: AgentUsage['fiveHour']) => {
    if (!value) return
    const left = timeLeft(value.resetsAt, now)
    parts.push(`${label} ${value.percent}% 사용${left ? `, ${left} 뒤 초기화` : ''}`)
  }
  window('5시간', usage.fiveHour)
  window('7일', usage.sevenDay)
  if (usage.context) parts.push(`컨텍스트 ${usage.context.percent}%`)
  return parts.join(' · ')
}
