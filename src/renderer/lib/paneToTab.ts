// A split pane dragged onto the tab bar becomes a tab, with its shell as it is, and the pane's place
// in the old tab stays empty until it is merged away.
// - SSH tab: the main process gives the shell's channel a session of its own on the same SSH
//   connection (ssh-adopt-split) and the screen is carried over.
// - Local terminal tab: the pane's shell is already a shell of its own in the main process; the new
//   tab simply takes its id and attaches to it.

import { useTerminalStore, type TerminalInfo } from '../stores/terminalStore'
import { MAIN_PANE, vacatePane, type PaneId } from './splitTree'
import { splitShellOf } from './splitShells'
import { releaseLocalPaneShell } from './localPaneShells'
import { setPendingSnapshot } from './terminalSnapshots'

export type MoveResult = { ok: true; sessionId: string } | { ok: false; error: string }
type Side = 'primary' | 'secondary'

/** The pane's place becomes empty and the new tab appears, on the side it was dropped on */
function placeTab(ownerId: string, pane: PaneId, info: TerminalInfo, targetPane?: Side): void {
  const store = useTerminalStore.getState()
  const current = store.terminals.get(ownerId)
  if (current?.splitTree) store.setSplitTree(ownerId, vacatePane(current.splitTree, pane))
  // In the split view the tab goes to the side it was dropped on (without one: beside the tab it
  // came from). That side gets the focus first, so App's "new tab follows the focused side" agrees.
  const isSplitView = store.layout.mode === 'split' && !!store.layout.secondary
  const side = !isSplitView ? null : targetPane ?? (store.layout.secondary?.terminalIds.includes(ownerId) ? 'secondary' : 'primary')
  if (side) store.setActivePaneType(side)
  store.addTerminal(info.id, info)
  // New tabs land in the first pane
  if (side === 'secondary') useTerminalStore.getState().moveTerminalBetweenPanes(info.id, 'primary', 'secondary')
}

/** `targetPane`: in the split view, the side whose tab strip the pane was dropped on */
export async function movePaneToTab(ownerId: string, pane: PaneId, targetPane?: Side): Promise<MoveResult> {
  if (pane === MAIN_PANE) return { ok: false, error: '탭의 첫 터미널은 탭 자체라서 옮길 수 없습니다.' }
  const owner = useTerminalStore.getState().terminals.get(ownerId)
  if (!owner || !owner.splitTree) return { ok: false, error: '옮길 칸을 찾지 못했습니다.' }

  if (owner.local) {
    const shellId = releaseLocalPaneShell(ownerId, pane)
    if (!shellId) return { ok: false, error: '이 칸의 셸이 아직 열리지 않았습니다.' }
    const count = Array.from(useTerminalStore.getState().terminals.values()).filter(info => info.local).length
    placeTab(ownerId, pane, {
      id: shellId, host: '이 PC', username: '', connected: true,
      title: `${owner.local.shell} (${count + 1})`,
      local: owner.local
    }, targetPane)
    return { ok: true, sessionId: shellId }
  }

  const shell = splitShellOf(ownerId, pane)
  const streamId = shell?.streamId()
  if (!shell || !streamId) return { ok: false, error: '이 칸의 셸이 아직 열리지 않았습니다.' }
  if (typeof window.electronAPI.sshAdoptSplit !== 'function') return { ok: false, error: '앱을 다시 시작한 뒤에 쓸 수 있습니다.' }

  const adopted = await window.electronAPI.sshAdoptSplit(streamId)
  if (!adopted.success || !adopted.sessionId) return { ok: false, error: adopted.error || '셸을 옮기지 못했습니다.' }
  const sessionId = adopted.sessionId

  // From the answer on, the shell's output arrives as the new tab's and waits in the store's buffer.
  // What the pane received before that is drawn first, then its screen is taken: the new tab shows
  // the screen, then the buffered output, with nothing missing or twice.
  const screen = await shell.detach()
  if (screen) setPendingSnapshot(sessionId, screen)

  placeTab(ownerId, pane, {
    id: sessionId,
    host: owner.host,
    username: owner.username,
    connected: true,
    title: owner.title,
    color: owner.color,
    connectConfig: owner.connectConfig
  }, targetPane)
  return { ok: true, sessionId }
}
