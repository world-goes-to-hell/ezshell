import { useTerminalStore } from '../stores/terminalStore'
import { adoptLocalPaneShell, getLocalPaneShellId } from './localPaneShells'
import { MAIN_PANE, paneIds, singlePane, type PaneId } from './splitTree'
import { focusTabPane } from './paneFocus'

export type RestartResult = { ok: true } | { ok: false; error: string }

const PANE_CHANGED = '이 칸의 셸이 바뀌었습니다. 다시 시도해 주세요.'

/**
 * 터미널 재시작: a new shell of this PC in the folder the old one was in (its current folder, else the
 * tab's), put in the same pane, then the old one closed. The new shell opens first so a failure leaves
 * the pane as it was. Whatever ran in the old shell (an agent too) ends with it. The tab keeps its own folder
 * (`local.cwd`: its tab group, worktree badge and new panes go by it) even when the shell had moved elsewhere.
 */
export async function restartLocalPaneShell(tabId: string, pane: PaneId, shellId: string): Promise<RestartResult> {
  const currentTab = () => {
    const tab = useTerminalStore.getState().terminals.get(tabId)
    return tab?.local && paneIds(tab.splitTree ?? singlePane()).includes(pane) && getLocalPaneShellId(tabId, pane) === shellId ? tab : undefined
  }
  const before = currentTab()
  if (!before?.local) return { ok: false, error: PANE_CHANGED }
  const api = window.electronAPI
  if (!api.localShellOpen || !api.localShellClose) return { ok: false, error: '앱을 다시 시작한 뒤에 쓸 수 있습니다.' }
  // main reads it from the shell (the process, or the folder the prompt reported): local folders only
  const folder = await api.localShellCurrentDirectory?.(shellId).catch(() => null) ?? null
  const cwd = folder ?? before.local.cwd
  const opened = await api.localShellOpen({ cols: 80, rows: 24, ...(cwd && { cwd }) })
  if (!opened.success) return { ok: false, error: opened.error }
  const tab = currentTab()
  if (!tab?.local) {
    api.localShellClose(opened.id)
    return { ok: false, error: PANE_CHANGED }
  }

  const store = useTerminalStore.getState()
  if (pane !== MAIN_PANE) adoptLocalPaneShell(tabId, pane, opened.id)
  store.updateTerminalMeta(tabId, {
    ...(pane === MAIN_PANE ? { local: { ...tab.local, shellId: opened.id, shell: opened.name } } : {}),
    paneArrival: { pane, seq: (tab.paneArrival?.seq ?? 0) + 1 }
  })
  api.localShellClose(shellId)
  focusTabPane(store.focusTerminal, tabId, pane)
  return { ok: true }
}
