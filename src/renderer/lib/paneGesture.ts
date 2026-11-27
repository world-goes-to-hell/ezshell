import { confirmDialog } from '../stores/confirmStore'
import { useTerminalStore } from '../stores/terminalStore'
import { useAgentMessagesStore } from '../components/Terminal/AgentMessages'
import { getLocalPaneShellId } from './localPaneShells'
import { paneCloseMessage, paneCloseRisk } from './paneCloseRisk'
import { closeTabPane, mergePanes } from './paneToTab'
import type { PaneId, Rect, SplitAxis } from './splitTree'
import { existingTabHost } from './tabHosts'
import { terminalWithin } from './terminalPanes'

export type PaneGestureAction =
  | { kind: 'merge'; to: PaneId; expanded: Rect }
  | { kind: 'split'; axis: SplitAxis; ratio: number }
  /** A scribble over the pane: closes it as 이 칸 닫기 does */
  | { kind: 'close' }
  /** A scribble over the only pane of a tab: closes the tab as 탭 닫기 does (2026-11-27 user request) */
  | { kind: 'close-tab' }

/** Asks App to close a tab through 탭 닫기 (its agent question and shell cleanup); detail: the tab ID */
export const CLOSE_TAB_EVENT = 'ezshell:close-tab'

const OPERATIONS = { merge: '병합', split: '분할', close: '닫기', 'close-tab': '탭 닫기' } as const
const QUESTIONS = { merge: '병합하시겠습니까', split: '분할하시겠습니까', close: '닫으시겠습니까', 'close-tab': '닫으시겠습니까' } as const

/**
 * Why closing `pane` needs a question (lib/paneCloseRisk.ts), or null. Its screen is read where it is
 * drawn; a pane not found (not drawn yet) is not asked about.
 */
function closingPaneRisk(tabId: string, pane: PaneId, { withAgent = true } = {}): string | null {
  const wrapper = existingTabHost(tabId)?.querySelector(`[data-pane="${pane.replace(/["\\]/g, '')}"]`)
  const terminal = wrapper ? terminalWithin(wrapper) : null
  const shellId = getLocalPaneShellId(tabId, pane)
  const agent = shellId ? useAgentMessagesStore.getState().snapshot.agents.find(entry => entry.active && entry.shellId === shellId)?.kind : undefined
  // 탭 닫기 asks about a tab's agents itself; a second question about the same agent is left out
  if (agent && !withAgent) return null
  if (!terminal) return agent ? paneCloseRisk({ agent, alternate: false, cursorLine: '' }) : null
  const buffer = terminal.buffer.active
  // The cursor's line up to the cursor (a prompt's blank may be unwritten: ConPTY moves the cursor past
  // it), with the rows it wraps from in front (a long prompt and command take several rows)
  let row = buffer.baseY + buffer.cursorY
  let line = buffer.getLine(row)?.translateToString(false, 0, buffer.cursorX) ?? ''
  for (let rows = 0; rows < 20 && row > 0 && buffer.getLine(row)?.isWrapped; rows++) {
    row -= 1
    line = (buffer.getLine(row)?.translateToString(true) ?? '') + line
  }
  return paneCloseRisk({ agent, alternate: buffer.type === 'alternate', cursorLine: line })
}

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

  if (action.kind === 'close-tab') {
    // A program other than an agent (tail -f, vim, a build) is asked about here, as a scribbled pane is
    const risk = closingPaneRisk(tabId, from, { withAgent: false })
    if (risk && !await confirmDialog({
      title: '탭 닫기',
      message: `이 탭에서 ${risk}. 탭을 닫으면 셸과 그 안의 프로그램이 함께 종료됩니다. 닫을까요?`,
      confirmLabel: '탭 닫기',
      cancelLabel: '취소',
      danger: true
    })) return
    if (isCurrent()) window.dispatchEvent(new CustomEvent(CLOSE_TAB_EVENT, { detail: tabId }))
    return
  }

  const hasWorkingAgent = workingShellCandidates.length ? window.electronAPI.localShellHasWorkingAgent : undefined
  const operation = OPERATIONS[action.kind]
  if (hasWorkingAgent && await hasWorkingAgent(workingShellCandidates)) {
    if (!isCurrent()) return
    const confirmed = await confirmDialog({
      title: `터미널 ${operation}`,
      message: `작업 중인 터미널이 있습니다. 정말 ${QUESTIONS[action.kind]}?`,
      confirmLabel: operation,
      cancelLabel: '취소',
      danger: action.kind !== 'split'
    })
    if (!confirmed) return
  } else {
    // A merge closes the pane dragged onto, a scribble its own pane: SSH panes and programs other than a
    // working agent (tail -f, vim, an idle agent) are asked about too (design review D9)
    const closing = action.kind === 'merge' ? action.to : action.kind === 'close' ? from : null
    const risk = closing ? closingPaneRisk(tabId, closing) : null
    if (risk) {
      const confirmed = await confirmDialog({
        title: `터미널 ${operation}`,
        message: paneCloseMessage(risk),
        confirmLabel: '칸 닫기',
        cancelLabel: '취소',
        danger: true
      })
      if (!confirmed) return
    }
  }

  if (!isCurrent()) return
  if (action.kind === 'merge') return mergePanes(tabId, from, action.to)
  if (action.kind === 'close') return closeTabPane(tabId, from)
  useTerminalStore.getState().splitTerminalPane(tabId, from, action.axis, action.ratio)
}
