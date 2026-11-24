import { confirmDialog } from '../stores/confirmStore'
import { useTerminalStore } from '../stores/terminalStore'
import { getLocalPaneShellId } from './localPaneShells'
import { closeTabPane, mergePanes } from './paneToTab'
import type { PaneId, Rect, SplitAxis } from './splitTree'

export type PaneGestureAction =
  | { kind: 'merge'; to: PaneId; expanded: Rect }
  | { kind: 'split'; axis: SplitAxis; ratio: number }
  /** A scribble over the pane: closes it as 이 칸 닫기 does */
  | { kind: 'close' }

const OPERATIONS = { merge: '병합', split: '분할', close: '닫기' } as const
const QUESTIONS = { merge: '병합하시겠습니까', split: '분할하시겠습니까', close: '닫으시겠습니까' } as const

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
    const operation = OPERATIONS[action.kind]
    const confirmed = await confirmDialog({
      title: `터미널 ${operation}`,
      message: `작업 중인 터미널이 있습니다. 정말 ${QUESTIONS[action.kind]}?`,
      confirmLabel: operation,
      cancelLabel: '취소',
      danger: action.kind !== 'split'
    })
    if (!confirmed) return
  }

  if (!isCurrent()) return
  if (action.kind === 'merge') return mergePanes(tabId, from, action.to)
  if (action.kind === 'close') return closeTabPane(tabId, from)
  useTerminalStore.getState().splitTerminalPane(tabId, from, action.axis, action.ratio)
}
