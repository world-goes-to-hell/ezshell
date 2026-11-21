import type { AgentChatItem, AgentTurnUsage } from '../types'

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

/** +2% / +0.4% / <1% (a window read in whole percent shows no change for a small question) */
export function limitStep(used: number): string {
  if (used <= 0) return '<1%'
  return `+${Number.isInteger(used) ? used : used.toFixed(1)}%`
}

/** The line: "토큰 입력 12.3만 · 출력 3,412 · 캐시 98% · 52초 · 5시간 +2% · 주간 <1%" and its exact numbers for the tooltip */
export function turnUsageText(usage: AgentTurnUsage): { text: string; title: string } {
  const parts = [`토큰 입력 ${tokenCount(usage.input)}`, `출력 ${tokenCount(usage.output)}`]
  if (usage.input > 0 && usage.cached > 0) parts.push(`캐시 ${Math.round((usage.cached / usage.input) * 100)}%`)
  if (usage.durationMs) parts.push(duration(usage.durationMs))
  const { fiveHour, sevenDay } = usage.limits ?? {}
  if (fiveHour !== undefined) parts.push(`5시간 ${limitStep(fiveHour)}`)
  if (sevenDay !== undefined) parts.push(`주간 ${limitStep(sevenDay)}`)
  const title = [
    `이번 질문에 쓴 토큰`,
    `입력 ${exact(usage.input)} (캐시에서 읽음 ${exact(usage.cached)})`,
    `출력 ${exact(usage.output)} (생각 포함)`,
    ...(usage.limits ? ['', '한도: 질문 전과 마지막 답변 뒤의 사용률 차이입니다.', '같은 계정의 다른 세션이 그동안 쓴 것도 함께 들어갑니다.'] : [])
  ].join('\n')
  return { text: parts.join(' · '), title }
}
