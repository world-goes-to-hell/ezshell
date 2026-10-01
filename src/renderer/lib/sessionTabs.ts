import type { TerminalInfo, LayoutState } from '../stores/terminalStore'

export type TabStatus = 'connected' | 'disconnected'

export interface SessionTab {
  id: string
  label: string
  /** 1-based position among all open tabs */
  index: number
  path?: string
}

export type SessionTabGroup = Record<TabStatus, SessionTab[]>

/**
 * Open tabs keyed by the sidebar session they were opened from. Tab ids are made per connection
 * by the main process, so the sidebar session is only reachable through connectConfig.savedSessionId.
 * Quick connects have no sidebar session and are left out.
 */
export function groupTabsBySession(terminals: ReadonlyMap<string, TerminalInfo>): Map<string, SessionTabGroup> {
  const groups = new Map<string, SessionTabGroup>()
  let index = 0
  for (const terminal of terminals.values()) {
    index += 1
    const savedSessionId = terminal.connectConfig?.savedSessionId
    if (!savedSessionId) continue

    const group = groups.get(savedSessionId) ?? { connected: [], disconnected: [] }
    const status: TabStatus = terminal.connected ? 'connected' : 'disconnected'
    const sessionTab: SessionTab = {
      id: terminal.id,
      label: terminal.title || `${terminal.username}@${terminal.host}`,
      index,
      path: terminal.currentPath
    }
    groups.set(savedSessionId, { ...group, [status]: [...group[status], sessionTab] })
  }
  return groups
}

/** Pane holding the tab while the view is split; null in single mode or when the tab is in neither pane */
export function findTabPane(layout: LayoutState, terminalId: string): 'primary' | 'secondary' | null {
  if (layout.mode !== 'split') return null
  if (layout.primary.terminalIds.includes(terminalId)) return 'primary'
  if (layout.secondary?.terminalIds.includes(terminalId)) return 'secondary'
  return null
}

export function badgeLabel(status: TabStatus, count: number): string {
  return status === 'connected' ? `연결된 탭 ${count}개` : `연결이 끊긴 탭 ${count}개`
}

/** Tooltip / accessible name: a single tab opens right away, several open a list to pick from */
export function badgeHint(status: TabStatus, count: number): string {
  return `${badgeLabel(status, count)} · ${count === 1 ? '눌러서 이동' : '눌러서 선택'}`
}
