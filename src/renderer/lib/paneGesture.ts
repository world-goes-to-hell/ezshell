import { confirmDialog } from '../stores/confirmStore'
import { useTerminalStore } from '../stores/terminalStore'
import { getLocalPaneShellId } from './localPaneShells'
import { mergePanes } from './paneToTab'
import type { PaneId, Rect, SplitAxis } from './splitTree'

export type PaneGestureAction =
  | { kind: 'merge'; to: PaneId; expanded: Rect }
  | { kind: 'split'; axis: SplitAxis; ratio: number }

/** Commits the Alt+drag after checking the actual shells of its source and destination. */
export async function commitPaneGesture(tabId: string, from: PaneId, action: PaneGestureAction, isVisible: () => boolean) {
  const tabOf = () => useTerminalStore.getState().terminals.get(tabId)
  const original = tabOf()
  if (!original) return

  const panes = action.kind === 'merge' ? [from, action.to] : [from]
  const shellIds = panes.map(pane => getLocalPaneShellId(tabId, pane))
  const workingShellCandidates = shellIds.filter((id): id is string => id !== undefined)
  const isCurrent = () => {
    const current = tabOf()
    return isVisible() && current && current.splitTree === original.splitTree && current.paneSeq === original.paneSeq
      && panes.every((pane, index) => getLocalPaneShellId(tabId, pane) === shellIds[index])
  }

  const hasWorkingAgent = workingShellCandidates.length ? window.electronAPI.localShellHasWorkingAgent : undefined
  if (hasWorkingAgent && await hasWorkingAgent(workingShellCandidates)) {
    if (!isCurrent()) return
    const operation = action.kind === 'merge' ? '병합' : '분할'
    const confirmed = await confirmDialog({
      title: `터미널 ${operation}`,
      message: `작업 중인 터미널이 있습니다. 정말 ${operation}하시겠습니까?`,
      confirmLabel: operation,
      cancelLabel: '취소',
      danger: action.kind === 'merge'
    })
    if (!confirmed) return
  }

  if (!isCurrent()) return
  if (action.kind === 'merge') return mergePanes(tabId, from, action.to)
  useTerminalStore.getState().splitTerminalPane(tabId, from, action.axis, action.ratio)
}
