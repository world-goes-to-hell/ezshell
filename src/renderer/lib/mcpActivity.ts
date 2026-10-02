import type { McpActivityItem, McpActivityState, McpOutputPart } from '../types'

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

function joinParts(parts: McpOutputPart[], added: McpOutputPart[]): McpOutputPart[] {
  return added.reduce<McpOutputPart[]>((list, part) => {
    const last = list[list.length - 1]
    return last && last.stream === part.stream
      ? [...list.slice(0, -1), { stream: part.stream, text: last.text + part.text }]
      : [...list, part]
  }, parts)
}

/**
 * Add live output to a request that is still active. A finished request already carries all of its
 * output (the main process sends it with the final state), so anything arriving later is ignored.
 */
export function appendOutputParts(list: McpActivityItem[], id: string, parts: McpOutputPart[]): McpActivityItem[] {
  const target = list.find(item => item.id === id)
  if (!target || !isActiveState(target.state) || parts.length === 0) return list
  const next = { ...target, outputParts: joinParts(target.outputParts ?? [], parts) }
  return list.map(item => (item.id === id ? next : item))
}

// C0/C1 controls except \n and \t (escape sequences are already removed in the main process),
// plus zero-width characters and bidi controls, which could make a line read differently from what it is
const CONTROL_CHARS = /[\u0000-\u0008\u000B-\u001F\u007F-\u009F​-‏⁠﻿‪-‮⁦-⁩]/g

/** Output as plain text for the terminal view: \r\n and a lone \r become a line break, other controls go. */
export function cleanTerminalText(text: string): string {
  return text.replace(/\r\n?/g, '\n').replace(CONTROL_CHARS, '')
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

/** How long a finished request took; under a second keeps one decimal ("0.2초"). */
export function formatDuration(ms: number): string {
  const safe = Math.max(0, ms)
  return safe < 1000 ? `${(safe / 1000).toFixed(1)}초` : formatElapsed(safe)
}

/** Wall-clock time (HH:MM:SS) of an ISO timestamp; the text itself when it cannot be parsed. */
export function formatClock(iso: string): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return iso
  const pad = (value: number) => String(value).padStart(2, '0')
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
}

/**
 * Whether the command reached the server. A request that was blocked, denied, expired or failed
 * before running has no exit code field at all; one that ran has a number or null.
 */
export function hasRun(item: McpActivityItem): boolean {
  return item.exitCode !== undefined
}
