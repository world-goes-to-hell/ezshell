// A past agent session dragged out of the agent history panel and dropped to resume it:
// - on a tab strip (or the start screen): in a new local terminal tab, as "이어서 실행" does;
// - on a local pane's edge: in a new pane on that side; in its center: replace the existing shell.
//   An empty place is filled as it is. A tab in the strip uses its empty place or its largest pane.
// The agent runs on this PC, so SSH and DB tabs do not take it. The main process opens the shell from
// the session's key alone (local-shell-open resolves its folder and agent).

import { useTerminalStore } from '../stores/terminalStore'
import { tabHost } from './tabHosts'
import { adoptLocalPaneShell, getLocalPaneShellId } from './localPaneShells'
import { halfOf, zoneAt } from './paneDropZones'
import { treeWithArrival, type MergePlace } from './tabToPane'
import { MAIN_PANE, paneIds, singlePane, type PaneId } from './splitTree'
import { focusTabPane } from './paneFocus'
import type { ResumeAgentSessionRequest } from './agentHistory'

export const AGENT_SESSION_DRAG_TYPE = 'application/x-ezshell-agent-session'

/** The session being dragged in this window (drag events do not show the data until the drop) */
let dragged: ResumeAgentSessionRequest | null = null

/** While a session is dragged the panel it came from fades and lets the pointer through (CSS
 * `[data-agent-drag]`): it lies over the terminal area, where the session is dropped */
const DRAG_FLAG = 'agentDrag'

export function startAgentSessionDrag(event: DragEvent | React.DragEvent, request: ResumeAgentSessionRequest): void {
  dragged = request
  // After the drag has started: changing the page in dragstart can cancel the drag or its image
  window.setTimeout(() => { if (dragged === request) document.documentElement.dataset[DRAG_FLAG] = 'on' }, 0)
  if (!event.dataTransfer) return
  event.dataTransfer.effectAllowed = 'copy'
  event.dataTransfer.setData(AGENT_SESSION_DRAG_TYPE, request.key)
}

export function endAgentSessionDrag(): void {
  dragged = null
  delete document.documentElement.dataset[DRAG_FLAG]
}

export function draggedAgentSession(): ResumeAgentSessionRequest | null {
  return dragged
}

export const NOT_LOCAL = '에이전트 대화는 로컬 터미널 탭에서만 이어서 열 수 있습니다.'
const PANE_CHANGED = '이 칸의 셸이 바뀌었습니다. 다시 끌어 놓아 주세요.'

interface AgentPaneReplacement {
  pane: PaneId
  shellId: string
}

export interface AgentDropHover {
  /** Absent: a new tab */
  targetId?: string
  place?: MergePlace
  replacement?: AgentPaneReplacement
  onTab: boolean
  box: { left: number; top: number; width: number; height: number }
  blocked: string | null
}

const PANES = '[data-pane], [data-vacant]'
const TABS = '.terminal-tab[data-tab-id], .split-pane-tab-item[data-tab-id]'
const NEW_TAB_AREAS = '.terminal-tabs, .split-pane-header, .welcome-screen'
/** The panel the drag starts from lies over the terminal area: nothing is dropped through it */
const PANEL = '.mcp-activity-panel'

const boxOf = (element: Element) => {
  const rect = element.getBoundingClientRect()
  return { left: rect.left, top: rect.top, width: rect.width, height: rect.height }
}

function roomIn(targetId: string, place?: MergePlace): string | null {
  const tab = useTerminalStore.getState().terminals.get(targetId)
  if (!tab?.local) return NOT_LOCAL
  const arrival = treeWithArrival(targetId, place)
  return 'error' in arrival ? arrival.error : null
}

/** What a drop at (x, y) would do; null where it does nothing */
export function agentDropAt(x: number, y: number): AgentDropHover | null {
  const stack = document.elementsFromPoint(x, y)
  if (stack[0]?.closest(PANEL)) return null
  const tabs = useTerminalStore.getState().terminals
  const tabElement = stack.find(candidate => candidate.matches(TABS))
  if (tabElement instanceof HTMLElement) {
    const targetId = tabElement.dataset.tabId ?? ''
    if (!tabs.has(targetId)) return null
    return { targetId, onTab: true, box: boxOf(tabElement), blocked: roomIn(targetId) }
  }
  const strip = stack.find(candidate => candidate.matches(NEW_TAB_AREAS))
  if (strip) return { onTab: true, box: boxOf(strip), blocked: null }
  // Tabs that are not in front are hidden with visibility and are not found here
  const element = stack.find(candidate => candidate.matches(PANES))
  if (!(element instanceof HTMLElement)) return null
  const targetId = Array.from(tabs.keys()).find(id => tabHost(id).contains(element))
  if (!targetId) return null
  const rect = element.getBoundingClientRect()
  const paneBox = { x: rect.left, y: rect.top, w: rect.width, h: rect.height }
  const vacant = element.dataset.vacant
  const pane = element.dataset.pane ?? ''
  const zone = vacant ? undefined : zoneAt(paneBox, x, y, true)
  if (zone === 'center') {
    const shellId = element.dataset.localShellId
    const blocked = !tabs.get(targetId)?.local ? NOT_LOCAL : shellId ? null : '셸이 열린 뒤 다시 시도해 주세요.'
    return { targetId, onTab: false, box: boxOf(element), blocked, replacement: shellId ? { pane, shellId } : undefined }
  }
  const side = zone
  const place: MergePlace = vacant ? { pane: vacant, isVacant: true } : { pane, isVacant: false, side }
  const shown = side ? halfOf(paneBox, side) : paneBox
  return { targetId, place, onTab: false, box: { left: shown.x, top: shown.y, width: shown.w, height: shown.h }, blocked: roomIn(targetId, place) }
}

export type AgentDropResult = { ok: true } | { ok: false; error: string }

/** Keep the pane and its geometry. Start the new shell before giving up the old one. */
export async function replaceAgentPane(request: ResumeAgentSessionRequest, targetId: string, replacement: AgentPaneReplacement): Promise<AgentDropResult> {
  const { pane, shellId } = replacement
  const currentTab = () => {
    const tab = useTerminalStore.getState().terminals.get(targetId)
    return tab?.local && paneIds(tab.splitTree ?? singlePane()).includes(pane) && getLocalPaneShellId(targetId, pane) === shellId ? tab : undefined
  }
  if (!currentTab()) return { ok: false, error: PANE_CHANGED }
  const api = window.electronAPI
  if (!api.localShellOpen || !api.localShellClose) return { ok: false, error: '앱을 다시 시작한 뒤에 쓸 수 있습니다.' }
  const opened = await api.localShellOpen({ cols: 80, rows: 24, resume: request.key, replacementFor: shellId })
  if (!opened.success) return { ok: false, error: opened.error }
  const tab = currentTab()
  if (!tab?.local) {
    api.localShellClose(opened.id)
    return { ok: false, error: PANE_CHANGED }
  }

  const store = useTerminalStore.getState()
  if (pane !== MAIN_PANE) adoptLocalPaneShell(targetId, pane, opened.id)
  store.updateTerminalMeta(targetId, {
    ...(pane === MAIN_PANE ? { local: { ...tab.local, shellId: opened.id, shell: opened.name, cwd: opened.cwd } } : {}),
    paneArrival: { pane, seq: (tab.paneArrival?.seq ?? 0) + 1 }
  })
  api.localShellClose(shellId)
  focusTabPane(store.focusTerminal, targetId, pane)
  return { ok: true }
}

/** Resumes the session in a new pane of a local terminal tab */
export async function resumeIntoPane(request: ResumeAgentSessionRequest, targetId: string, place?: MergePlace): Promise<AgentDropResult> {
  const blocked = roomIn(targetId, place)
  if (blocked) return { ok: false, error: blocked }
  const open = window.electronAPI.localShellOpen
  if (!open) return { ok: false, error: '앱을 다시 시작한 뒤에 쓸 수 있습니다.' }
  const opened = await open({ cols: 80, rows: 24, resume: request.key })
  if (!opened.success) return { ok: false, error: opened.error }
  // The tab may have changed or closed while the shell was opening: place it on the tree as it is now
  const arrival = useTerminalStore.getState().terminals.get(targetId)?.local ? treeWithArrival(targetId, place) : { error: '탭이 닫혔습니다.' }
  if ('error' in arrival) {
    window.electronAPI.localShellClose?.(opened.id)
    return { ok: false, error: arrival.error }
  }
  adoptLocalPaneShell(targetId, arrival.pane, opened.id)
  const store = useTerminalStore.getState()
  const target = store.terminals.get(targetId)
  store.updateTerminalMeta(targetId, {
    isSplit: true,
    splitTree: arrival.tree,
    paneSeq: arrival.seq,
    paneArrival: { pane: arrival.pane, seq: (target?.paneArrival?.seq ?? 0) + 1 }
  })
  store.focusTerminal(targetId)
  requestAnimationFrame(() => window.dispatchEvent(new Event('resize')))
  return { ok: true }
}
