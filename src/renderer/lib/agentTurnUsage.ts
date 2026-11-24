import type { AgentChatItem, AgentTurnLimitUsage, AgentTurnUsage } from '../types'

// The tokens of each question in the chat view, drawn at the end of its turn (the usage rides on the
// user item that started the turn: src/agentChat/turnUsage.js).

/** item id → the usage to draw after that item (the last item of a turn) */
export function turnUsageSpots(items: readonly AgentChatItem[]): Map<string, AgentTurnUsage> {
  const spots = new Map<string, AgentTurnUsage>()
  let usage: AgentTurnUsage | undefined
  let last: string | null = null
  const close = () => { if (usage && last) spots.set(last, usage) }
  for (const item of items) {
    if (item.kind === 'user') {
      close()
      usage = item.usage
    }
    last = item.id
  }
  close()
  return spots
}

const exact = (value: number) => value.toLocaleString('ko-KR')

/** 3,412 / 12.3만 / 120만 */
export function tokenCount(value: number): string {
  if (value < 10_000) return exact(value)
  const man = value / 10_000
  return `${man < 100 ? man.toFixed(1).replace(/\.0$/, '') : Math.round(man)}만`
}

function duration(ms: number): string {
  const seconds = Math.max(1, Math.round(ms / 1000))
  if (seconds < 60) return `${seconds}초`
  const minutes = Math.floor(seconds / 60)
  return seconds % 60 ? `${minutes}분 ${seconds % 60}초` : `${minutes}분`
}

function limitText({ before, after, used, reset }: AgentTurnLimitUsage): string {
  const readings = `${before}% → ${after}%`
  if (reset) return used > 0 ? `${readings} (초기화 후 +${used}%p)` : `${readings} (초기화)`
  return used > 0 ? `${readings} (+${used}%p)` : readings
}

/** The token and limit usage summary, with exact token counts in its tooltip. */
export function turnUsageText(usage: AgentTurnUsage): { text: string; title: string } {
  const parts = [`토큰 입력 ${tokenCount(usage.input)}`, `출력 ${tokenCount(usage.output)}`]
  if (usage.input > 0 && usage.cached > 0) parts.push(`캐시 ${Math.round((usage.cached / usage.input) * 100)}%`)
  if (usage.durationMs) parts.push(duration(usage.durationMs))
  const { fiveHour, sevenDay } = usage.limits ?? {}
  if (fiveHour) parts.push(`5시간 ${limitText(fiveHour)}`)
  if (sevenDay) parts.push(`주간 ${limitText(sevenDay)}`)
  const title = [
    `이번 질문에 쓴 토큰`,
    `입력 ${exact(usage.input)} (캐시에서 읽음 ${exact(usage.cached)})`,
    `출력 ${exact(usage.output)} (생각 포함)`,
    ...(usage.limits ? ['', '질문 전과 마지막 답변 뒤에 기록된 한도 사용률입니다.', '같은 계정의 다른 세션 사용량도 포함될 수 있습니다.'] : [])
  ].join('\n')
  return { text: parts.join(' · '), title }
}
