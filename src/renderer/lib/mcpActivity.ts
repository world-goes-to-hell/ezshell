import type { McpActivityItem, McpActivityState } from '../types'

export const MAX_ACTIVITY = 100

export const ACTIVITY_STATE_LABELS: Record<McpActivityState, string> = {
  waiting: '확인 대기',
  running: '실행 중',
  done: '완료',
  timeout: '시간 초과',
  denied: '거부',
  expired: '미응답(만료)',
  cancelled: '취소',
  blocked: '차단',
  failed: '실패'
}

export function isActiveState(state: McpActivityState): boolean {
  return state === 'waiting' || state === 'running'
}

export function upsertActivity(list: McpActivityItem[], next: McpActivityItem, max: number = MAX_ACTIVITY): McpActivityItem[] {
  return [next, ...list.filter(item => item.id !== next.id)]
    .sort((a, b) => b.startedAt - a.startedAt)
    .slice(0, max)
}

/**
 * Combine a fresh snapshot from the main process with live events.
 * The snapshot is authoritative, except for items a live event updated during the current
 * subscription (those can be newer than the snapshot). Stale local items are dropped.
 */
export function mergeSnapshot(current: McpActivityItem[], snapshot: McpActivityItem[], liveIds: ReadonlySet<string>, max: number = MAX_ACTIVITY): McpActivityItem[] {
  const fromSnapshot = snapshot.reduce<McpActivityItem[]>((list, entry) => upsertActivity(list, entry, max), [])
  return current
    .filter(entry => liveIds.has(entry.id))
    .reduce<McpActivityItem[]>((list, entry) => upsertActivity(list, entry, max), fromSnapshot)
}

export function countActive(list: McpActivityItem[]): { waiting: number; running: number } {
  return {
    waiting: list.filter(item => item.state === 'waiting').length,
    running: list.filter(item => item.state === 'running').length
  }
}

export function formatElapsed(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000))
  const minutes = Math.floor(seconds / 60)
  return minutes > 0 ? `${minutes}분 ${seconds % 60}초` : `${seconds}초`
}
