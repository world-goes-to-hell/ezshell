// A split pane dragged onto the tab bar becomes a tab, with its shell as it is, and the pane's place
// in the old tab stays empty until it is merged away.
// - SSH tab: the main process gives the shell's channel a session of its own on the same SSH
//   connection (ssh-adopt-split) and the screen is carried over.
// - Local terminal tab: the pane's shell is already a shell of its own in the main process; the new
//   tab simply takes its id and attaches to it.

import { useTerminalStore, type TerminalInfo } from '../stores/terminalStore'
import { MAIN_PANE, assignMainPane, closePane, mergePaneLayout, paneIds, swapPanes, vacatePane, type PaneId } from './splitTree'
import { mainScreenOf, splitShellOf } from './splitShells'
import { hasLocalPaneShell, releaseLocalPaneShell } from './localPaneShells'
import { captureDrawnSnapshot, setPendingSnapshot } from './terminalSnapshots'
import { focusTabPane } from './paneFocus'

export type MoveResult = { ok: true; sessionId: string } | { ok: false; error: string }
type Side = 'primary' | 'secondary'
const moves = new Set<string>()

/** The pane's place becomes empty and the new tab appears, on the side it was dropped on */
function placeTab(ownerId: string, pane: PaneId, info: TerminalInfo, targetPane: Side | undefined, replacement: PaneId | undefined): void {
  const store = useTerminalStore.getState()
  const current = store.terminals.get(ownerId)
  if (current?.splitTree) {
    const tree = replacement ? swapPanes(current.splitTree, MAIN_PANE, replacement) : current.splitTree
    store.setSplitTree(ownerId, vacatePane(tree, replacement ?? pane))
  }
  // In the split view the tab goes to the side it was dropped on (without one: beside the tab it
  // came from). That side gets the focus first, so App's "new tab follows the focused side" agrees.
  const isSplitView = store.layout.mode === 'split' && !!store.layout.secondary
  const side = !isSplitView ? null : targetPane ?? (store.layout.secondary?.terminalIds.includes(ownerId) ? 'secondary' : 'primary')
  if (side) store.setActivePaneType(side)
  store.addTerminal(info.id, { ...info, paneArrival: { pane: MAIN_PANE, seq: 1 } })
  // New tabs land in the first pane
  if (side === 'secondary') useTerminalStore.getState().moveTerminalBetweenPanes(info.id, 'primary', 'secondary')
}

/** `targetPane`: in the split view, the side whose tab strip the pane was dropped on */
export async function movePaneToTab(ownerId: string, pane: PaneId, targetPane?: Side): Promise<MoveResult> {
  const owner = useTerminalStore.getState().terminals.get(ownerId)
  if (!owner || !owner.splitTree) return { ok: false, error: '옮길 칸을 찾지 못했습니다.' }
  const panes = paneIds(owner.splitTree)
  if (!panes.includes(pane)) return { ok: false, error: '옮길 칸을 찾지 못했습니다.' }
  const replacement = pane === MAIN_PANE ? readyPane(owner, panes.filter(id => id !== MAIN_PANE)) : undefined
  if (pane === MAIN_PANE && !replacement) return { ok: false, error: '이 탭에 남을 셸이 필요합니다.' }
  if (moves.has(ownerId)) return { ok: false, error: '이 탭의 셸을 옮기는 중입니다.' }
  moves.add(ownerId)
  try {
    const moved = owner.local ? moveLocal(owner, pane, replacement) : await moveSsh(owner, pane, replacement)
    if ('error' in moved) return { ok: false, error: moved.error }
    if (!useTerminalStore.getState().terminals.has(ownerId)) {
      if (moved.local) window.electronAPI.localShellClose?.(moved.local.shellId ?? moved.id)
      else window.electronAPI.sshDisconnect(moved.id)
      return { ok: false, error: '원래 탭이 닫혔습니다.' }
    }
    placeTab(ownerId, pane, moved, targetPane, replacement)
    requestAnimationFrame(() => window.dispatchEvent(new Event('resize')))
    return { ok: true, sessionId: moved.id }
  } finally {
    moves.delete(ownerId)
  }
}

function readyPane(owner: TerminalInfo, candidates: PaneId[]): PaneId | undefined {
  return candidates.find(id => owner.local ? hasLocalPaneShell(owner.id, id) : Boolean(splitShellOf(owner.id, id)?.streamId()))
}

/** An Alt-drag keeps the source shell and closes the destination within the same tab. */
export async function mergePanes(ownerId: string, stay: PaneId, close: PaneId): Promise<MoveResult> {
  const store = useTerminalStore.getState()
  const owner = store.terminals.get(ownerId)
  const plan = owner?.splitTree && mergePaneLayout(owner.splitTree, stay, close, owner.paneSeq)
  if (!owner || !plan) return { ok: false, error: '이 방향으로 합칠 수 있는 칸을 찾지 못했습니다.' }
  if (moves.has(ownerId)) return { ok: false, error: '이 탭의 셸을 옮기는 중입니다.' }

  // The source can still be connecting. A different live shell may take over the main role
  // while the source stays in the enlarged pane and completes its own connection.
  const replacement = close === MAIN_PANE ? readyPane(owner, [stay, ...paneIds(plan.tree).filter(id => id !== stay)]) : undefined
  if (close === MAIN_PANE && !replacement) return { ok: false, error: '남길 셸의 연결이 끝난 뒤 다시 시도해 주세요.' }
  moves.add(ownerId)
  try {
    if (replacement && owner.local) {
      const oldShellId = promoteLocal(owner, replacement)
      if (!oldShellId) return { ok: false, error: '남길 셸을 찾지 못했습니다.' }
      window.electronAPI.localShellClose?.(oldShellId)
    } else if (replacement) {
      const promoted = await promoteSsh(ownerId, replacement, true)
      if ('error' in promoted) return { ok: false, error: promoted.error }
    }

    const current = useTerminalStore.getState().terminals.get(ownerId)
    if (!current) return { ok: false, error: '원래 탭이 닫혔습니다.' }
    const latest = current.splitTree === owner.splitTree ? plan
      : current.splitTree && mergePaneLayout(current.splitTree, stay, close, current.paneSeq)
    if (latest) {
      if (latest.seq > (current.paneSeq ?? 0)) store.updateTerminalMeta(ownerId, { paneSeq: latest.seq })
      store.setSplitTree(ownerId, replacement ? assignMainPane(latest.tree, replacement) : latest.tree, stay === replacement ? MAIN_PANE : stay)
    } else if (replacement && current.splitTree) {
      // If the layout changed while IPC was in flight, the old main channel is already closed.
      store.setSplitTree(ownerId, closePane(swapPanes(current.splitTree, MAIN_PANE, replacement), replacement))
    }
    focusTabPane(store.focusTerminal, ownerId, stay === replacement ? MAIN_PANE : stay)
    requestAnimationFrame(() => window.dispatchEvent(new Event('resize')))
    return { ok: true, sessionId: ownerId }
  } finally {
    moves.delete(ownerId)
  }
}

function promoteLocal(owner: TerminalInfo, replacement: PaneId): string | null {
  const splitId = releaseLocalPaneShell(owner.id, replacement)
  if (!splitId || !owner.local) return null
  useTerminalStore.getState().updateTerminalMeta(owner.id, { local: { ...owner.local, shellId: splitId } })
  return owner.local.shellId ?? owner.id
}

function moveLocal(owner: TerminalInfo, pane: PaneId, replacement?: PaneId): TerminalInfo | { error: string } {
  const store = useTerminalStore.getState()
  const { shell, cwd, workspaceLabel } = owner.local!
  const shellId = replacement ? promoteLocal(owner, replacement) : releaseLocalPaneShell(owner.id, pane)
  if (!shellId) return { error: '이 칸의 셸이 아직 열리지 않았습니다.' }
  let id = shellId
  while (store.terminals.has(id)) id = `local-tab-${id}`
  const count = Array.from(store.terminals.values()).filter(info => info.local).length
  return {
    id, host: '이 PC', username: '', connected: true, title: `${workspaceLabel ?? shell} (${count + 1})`,
    local: { shell, shellId, cwd, workspaceLabel }
  }
}

async function promoteSsh(ownerId: string, replacement: PaneId, closePrevious: boolean): Promise<{ sessionId?: string } | { error: string }> {
  const shell = splitShellOf(ownerId, replacement)
  const streamId = shell?.streamId()
  const api = window.electronAPI
  if (!shell || !streamId || !api.sshPromotePane || !api.sshResumePromotedPane || !mainScreenOf(ownerId)) {
    return { error: '탭에 남을 셸을 준비하지 못했습니다.' }
  }
  const adopted = await api.sshPromotePane(ownerId, streamId, closePrevious)
  if (!adopted.success) return { error: adopted.error || '셸을 옮기지 못했습니다.' }
  try {
    const [oldMain, promoted] = await Promise.all([adopted.sessionId ? captureDrawnSnapshot(ownerId) : null, shell.detach()])
    if (oldMain && adopted.sessionId) setPendingSnapshot(adopted.sessionId, oldMain)
    const replace = mainScreenOf(ownerId)
    if (replace) replace(promoted)
    else if (useTerminalStore.getState().terminals.has(ownerId)) setPendingSnapshot(ownerId, promoted)
  } finally {
    api.sshResumePromotedPane(ownerId, streamId)
  }
  return { sessionId: adopted.sessionId }
}

async function moveSsh(owner: TerminalInfo, pane: PaneId, replacement?: PaneId): Promise<TerminalInfo | { error: string }> {
  let sessionId: string | undefined
  if (replacement) {
    const promoted = await promoteSsh(owner.id, replacement, false)
    if ('error' in promoted) return promoted
    sessionId = promoted.sessionId
  } else {
    const shell = splitShellOf(owner.id, pane)
    const streamId = shell?.streamId()
    if (!shell || !streamId) return { error: '이 칸의 셸이 아직 열리지 않았습니다.' }
    const adopted = await window.electronAPI.sshAdoptSplit(streamId)
    if (!adopted.success || !adopted.sessionId) return { error: adopted.error || '셸을 옮기지 못했습니다.' }
    sessionId = adopted.sessionId
    const screen = await shell.detach()
    if (screen) setPendingSnapshot(sessionId, screen)
  }
  if (!sessionId) return { error: '옮겨진 셸의 탭을 찾지 못했습니다.' }

  return {
    id: sessionId,
    host: owner.host,
    username: owner.username,
    connected: true,
    title: owner.title,
    color: owner.color,
    connectConfig: owner.connectConfig,
    currentPath: replacement ? owner.currentPath : undefined
  }
}
