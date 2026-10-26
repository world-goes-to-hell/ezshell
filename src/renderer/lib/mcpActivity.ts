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

/**
 * At most `max` items of a newest-first list. The oldest finished ones go first: a request that is
 * still active (a background job runs for up to an hour) stays, so it can always be seen and stopped.
 */
function capItems(list: McpActivityItem[], max: number): McpActivityItem[] {
  let excess = list.length - max
  if (excess <= 0) return list
  return list.reduceRight<McpActivityItem[]>((kept, item) => {
    if (excess > 0 && !isActiveState(item.state)) { excess -= 1; return kept }
    return [item, ...kept]
  }, []).slice(0, max)
}

export function upsertActivity(list: McpActivityItem[], next: McpActivityItem, max: number = MAX_ACTIVITY): McpActivityItem[] {
  return capItems([next, ...list.filter(item => item.id !== next.id)].sort((a, b) => b.startedAt - a.startedAt), max)
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
 * Characters of output kept per request (the end of it); a background job can print for an hour.
 * Same limit as the main process (DEFAULT_MAX_OUTPUT_CHARS in src/mcp/activityLog.js).
 */
export const MAX_OUTPUT_CHARS = 512 * 1024

/** Pieces of output kept per request; output that switches streams all the time would otherwise pile up without end */
export const MAX_OUTPUT_PARTS = 2000

/** Drop output from the start until at most `max` characters are left. */
function trimParts(parts: McpOutputPart[], max: number): McpOutputPart[] {
  const total = parts.reduce((sum, part) => sum + part.text.length, 0)
  if (total <= max) return parts
  let excess = total - max
  let index = 0
  while (excess >= parts[index].text.length) {
    excess -= parts[index].text.length
    index += 1
  }
  const first = parts[index]
  return excess > 0 ? [{ stream: first.stream, text: first.text.slice(excess) }, ...parts.slice(index + 1)] : parts.slice(index)
}

/** At most `max` pieces: the oldest ones become one piece (their text stays, which stream it came from is lost). */
function mergeOldest(parts: McpOutputPart[], max: number): McpOutputPart[] {
  if (parts.length <= max) return parts
  const cut = parts.length - max + 1
  return [{ stream: 'stdout', text: parts.slice(0, cut).map(part => part.text).join('') }, ...parts.slice(cut)]
}

/**
 * Add live output to a request that is still active. A finished request already carries all of its
 * output (the main process sends it with the final state), so anything arriving later is ignored.
 */
export function appendOutputParts(list: McpActivityItem[], id: string, parts: McpOutputPart[], maxChars: number = MAX_OUTPUT_CHARS, maxParts: number = MAX_OUTPUT_PARTS): McpActivityItem[] {
  const target = list.find(item => item.id === id)
  if (!target || !isActiveState(target.state) || parts.length === 0) return list
  const joined = joinParts(target.outputParts ?? [], parts)
  const kept = trimParts(joined, maxChars)
  const next = { ...target, outputParts: mergeOldest(kept, maxParts), ...(kept === joined ? {} : { outputTrimmed: true }) }
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

/** The requests of one session, for the per-server view */
export interface McpActivityLane {
  sessionId: string
  /** Name on the most recent request (the session may have been renamed since the first one) */
  sessionName: string
  /** Oldest first, the order the terminal view reads in */
  items: McpActivityItem[]
  waiting: number
  running: number
}

/**
 * One lane per session. Lanes are ordered by their oldest request, so a lane keeps its place
 * while new requests arrive.
 */
export function groupBySession(list: McpActivityItem[]): McpActivityLane[] {
  const oldestFirst = [...list].sort((a, b) => a.startedAt - b.startedAt)
  const bySession = oldestFirst.reduce<Map<string, McpActivityItem[]>>(
    (map, item) => new Map(map).set(item.sessionId, [...(map.get(item.sessionId) ?? []), item]),
    new Map()
  )
  return [...bySession].map(([sessionId, items]) => ({
    sessionId,
    sessionName: items[items.length - 1].sessionName,
    items,
    ...countActive(items)
  }))
}

/**
 * Lanes in the order the user dragged them to (`order`, session ids). Sessions not in `order` keep their
 * natural place after the ordered ones, so a new session shows up at the end.
 */
export function orderLanes<T extends { sessionId: string }>(lanes: T[], order: readonly string[]): T[] {
  const rank = new Map(order.map((id, index) => [id, index]))
  const placed = lanes.filter(lane => rank.has(lane.sessionId)).sort((a, b) => rank.get(a.sessionId)! - rank.get(b.sessionId)!)
  return [...placed, ...lanes.filter(lane => !rank.has(lane.sessionId))]
}

/**
 * The order after dropping lane `fromId` on lane `toId`: it takes the target's place, before it when
 * moving up and after it when moving down. Unchanged for a drop on itself or on a lane not shown.
 */
export function moveLane<T extends { sessionId: string }>(lanes: T[], order: readonly string[], fromId: string, toId: string): string[] {
  const current = orderLanes(lanes, order).map(lane => lane.sessionId)
  const from = current.indexOf(fromId)
  const to = current.indexOf(toId)
  if (from < 0 || to < 0 || from === to) return [...order]
  const without = current.filter(id => id !== fromId)
  const at = without.indexOf(toId) + (from < to ? 1 : 0)
  return [...without.slice(0, at), fromId, ...without.slice(at)]
}

/** Lanes closed in the per-server view: session id → id of its most recent request when it was closed */
export type McpHiddenLanes = Readonly<Record<string, string>>

const newestId = (lane: McpActivityLane): string | undefined => lane.items[lane.items.length - 1]?.id

/** Close a lane until its session gets a new request */
export function hideLane(hidden: McpHiddenLanes, lane: McpActivityLane): McpHiddenLanes {
  const id = newestId(lane)
  return id === undefined ? hidden : { ...hidden, [lane.sessionId]: id }
}

/**
 * Hidden while its most recent request is the one it had when it was closed. A new request (waiting or
 * running) brings it back; output or a state change of a request it already had does not.
 */
export function isLaneHidden(lane: McpActivityLane, hidden: McpHiddenLanes): boolean {
  const id = newestId(lane)
  return id !== undefined && hidden[lane.sessionId] === id
}

/** Something a press landed on; only `closest` is used, so tests can pass a stand-in */
export interface McpPressTarget {
  closest?: (selector: string) => unknown
}

/**
 * A press on the app behind the activity panel (shell, SFTP, sidebar) slides the panel aside.
 * Presses on the panel, its status bar button, toasts, and anything drawn outside the app root
 * (dialogs, menus) leave it as it is: answering an approval dialog must not fold the panel away.
 */
export function collapsesMcpPanel(target: McpPressTarget | null): boolean {
  if (!target || typeof target.closest !== 'function') return false
  if (!target.closest('#root')) return false
  return !target.closest('#mcp-activity-panel, .mcp-activity-indicator, .toast-container')
}

/** How the activity panel shows requests: a list to expand, one continuous terminal-like log, or one such log per session */
export type McpActivityView = 'list' | 'terminal' | 'lanes'

/** What the panel remembers across restarts */
export interface McpActivityPrefs {
  view: McpActivityView
  /** Per-server view: hide the sessions that have nothing waiting or running */
  isActiveOnly: boolean
}

export const ACTIVITY_PREFS_KEY = 'mcpActivityPrefs'
export const DEFAULT_ACTIVITY_PREFS: McpActivityPrefs = { view: 'terminal', isActiveOnly: false }

const ACTIVITY_VIEWS: readonly string[] = ['list', 'terminal', 'lanes']

/** Stored preferences as read from localStorage; anything missing or not understood becomes the default. */
export function parseActivityPrefs(raw: string | null | undefined): McpActivityPrefs {
  if (!raw) return DEFAULT_ACTIVITY_PREFS
  try {
    const stored: unknown = JSON.parse(raw)
    if (typeof stored !== 'object' || stored === null) return DEFAULT_ACTIVITY_PREFS
    const { view, isActiveOnly } = stored as Record<string, unknown>
    return {
      view: typeof view === 'string' && ACTIVITY_VIEWS.includes(view) ? (view as McpActivityView) : DEFAULT_ACTIVITY_PREFS.view,
      isActiveOnly: typeof isActiveOnly === 'boolean' ? isActiveOnly : DEFAULT_ACTIVITY_PREFS.isActiveOnly
    }
  } catch {
    return DEFAULT_ACTIVITY_PREFS
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
