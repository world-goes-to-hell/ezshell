import type { TerminalInfo, LayoutState } from '../stores/terminalStore'
import { isSplitTree, type SplitNode } from './splitTree'

export type TabStatus = 'connected' | 'disconnected'

export interface SessionTab {
  id: string
  label: string
  /** 1-based position among all open tabs */
  index: number
  path?: string
  /** How the tab is divided, when it holds more than one pane (the list draws it, a pane can be picked) */
  splitTree?: SplitNode
}

export type SessionTabGroup = Record<TabStatus, SessionTab[]>

/**
 * Open tabs keyed by the sidebar session they were opened from. Tab ids are made per connection
 * by the main process, so the sidebar session is only reachable through connectConfig.savedSessionId.
 * Quick connects have no sidebar session and are left out.
 */
export function groupTabsBySession(
  terminals: ReadonlyMap<string, TerminalInfo>, includes: (id: string) => boolean = () => true
): Map<string, SessionTabGroup> {
  const groups = new Map<string, SessionTabGroup>()
  let index = 0
  for (const terminal of terminals.values()) {
    index += 1
    const savedSessionId = terminal.connectConfig?.savedSessionId
    if (!savedSessionId || !includes(terminal.id)) continue

    const group = groups.get(savedSessionId) ?? { connected: [], disconnected: [] }
    const status: TabStatus = terminal.connected ? 'connected' : 'disconnected'
    const sessionTab: SessionTab = {
      id: terminal.id,
      label: terminal.title || `${terminal.username}@${terminal.host}`,
      index,
      path: terminal.currentPath,
      ...(isSplitTree(terminal.splitTree) ? { splitTree: terminal.splitTree } : {})
    }
    groups.set(savedSessionId, { ...group, [status]: [...group[status], sessionTab] })
  }
  return groups
}

/** The screen (index) holding the tab while the view is split; null in single mode or when no screen has it */
export function findTabPane(layout: LayoutState, terminalId: string): number | null {
  if (layout.mode !== 'split') return null
  const index = layout.panes.findIndex(pane => pane.terminalIds.includes(terminalId))
  return index < 0 ? null : index
}

export function badgeLabel(status: TabStatus, count: number): string {
  return status === 'connected' ? `연결된 탭 ${count}개` : `연결이 끊긴 탭 ${count}개`
}

/** Tooltip / accessible name: a single tab opens right away, several open a list to pick from */
export function badgeHint(status: TabStatus, count: number): string {
  return `${badgeLabel(status, count)} · ${count === 1 ? '눌러서 이동' : '눌러서 선택'}`
}

/** A tab with an SSH shell supports SFTP, session logs, and duplicate connections. */
export function isSshTab(terminal: TerminalInfo | null | undefined): boolean {
  return Boolean(terminal) && !terminal?.db && !terminal?.local && !terminal?.browser
}
