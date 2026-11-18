// A tab merged into a pane of another tab of the same session, with its shell as it is: the
// opposite of lib/paneToTab.ts.
// - SSH tab: the main process turns the tab's shell channel into a split shell of the target tab
//   (ssh-merge-tab). The tab's session ends; the shell, and the connection it runs on, stay.
// - Local terminal tab: the tab's shell simply becomes the shell of the new pane.

import { useTerminalStore } from '../stores/terminalStore'
import { useStatsStore } from '../stores/statsStore'
import { useSftpStore } from '../stores/sftpStore'
import { fillVacant, layoutOf, nextPaneSeq, paneId, singlePane, splitPane, type PaneId, type SplitNode } from './splitTree'
import { mergeAxis, mergeBlock } from './tabMerge'
import { adoptLocalPaneShell } from './localPaneShells'
import { expectIncomingShell, setIncomingScreen } from './incomingShells'
import { captureDrawnSnapshot } from './terminalSnapshots'
import { tabHost } from './tabHosts'
import { canHalve, insertBeside, TOO_NARROW, type DropSide } from './paneDropZones'

export type MergeResult = { ok: true } | { ok: false; error: string }

/** Where in the target tab the shell goes: an empty place to fill, or a pane to halve */
export interface MergePlace {
  pane: PaneId
  isVacant: boolean
  /** The half of the pane the shell takes, chosen with the pointer (lib/paneDropZones.ts); absent: by its shape */
  side?: DropSide
}

const TOO_SMALL = '칸이 너무 작아 더 나눌 수 없습니다. 창을 넓히거나 다른 칸에 병합해 주세요.'

/** Size on screen of a pane of a tab (tabs that are not in front keep their layout) */
function paneSize(tabId: string, pane: PaneId): { width: number; height: number } | null {
  const element = tabHost(tabId).querySelector(`[data-pane="${CSS.escape(pane)}"]`)
  if (!element) return null
  const rect = element.getBoundingClientRect()
  return { width: rect.width, height: rect.height }
}

/** Without a place chosen by the pointer (the tab's menu): an empty place first, else the largest pane */
function defaultPlace(tree: SplitNode): MergePlace {
  const layout = layoutOf(tree)
  if (layout.vacants.length > 0) return { pane: layout.vacants[0].pane, isVacant: true }
  const largest = [...layout.panes].sort((a, b) => b.rect.w * b.rect.h - a.rect.w * a.rect.h)[0]
  return { pane: largest.pane, isVacant: false }
}

/** The target's tree with a new pane at `place`, or why there is no room for it */
export function treeWithArrival(targetId: string, place?: MergePlace): { tree: SplitNode; pane: PaneId; seq: number } | { error: string } {
  const target = useTerminalStore.getState().terminals.get(targetId)
  if (!target) return { error: '병합할 탭을 찾지 못했습니다.' }
  const tree = target.splitTree ?? singlePane()
  const at = place ?? defaultPlace(tree)
  const seq = nextPaneSeq(tree, target.paneSeq ?? 0)
  const pane = paneId(seq)
  if (at.isVacant) {
    const filled = fillVacant(tree, at.pane, pane)
    return filled === tree ? { error: '병합할 자리를 찾지 못했습니다.' } : { tree: filled, pane, seq }
  }
  const size = paneSize(targetId, at.pane)
  if (at.side) {
    if (size && !canHalve(size.width, size.height, at.side)) return { error: TOO_NARROW }
    const beside = insertBeside(tree, at.pane, at.side, pane)
    return beside === tree ? { error: '병합할 자리를 찾지 못했습니다.' } : { tree: beside, pane, seq }
  }
  const axis = size ? mergeAxis(size.width, size.height) : 'row'
  if (!axis) return { error: TOO_SMALL }
  const divided = splitPane(tree, at.pane, axis, pane)
  return divided === tree ? { error: '병합할 자리를 찾지 못했습니다.' } : { tree: divided, pane, seq }
}

export async function mergeTabIntoPane(sourceId: string, targetId: string, place?: MergePlace): Promise<MergeResult> {
  const before = useTerminalStore.getState().terminals
  const source = before.get(sourceId)
  const isLocal = Boolean(source?.local)
  let hasPortForwards = false
  if (source && !isLocal && !source.db) {
    try {
      hasPortForwards = (await window.electronAPI.portForwardList(sourceId)).length > 0
    } catch {
      hasPortForwards = false // the main process checks again
    }
  }
  const blocked = mergeBlock(useTerminalStore.getState().terminals, sourceId, targetId, hasPortForwards)
  if (blocked) return { ok: false, error: blocked }
  const arrival = treeWithArrival(targetId, place)
  if ('error' in arrival) return { ok: false, error: arrival.error }

  if (isLocal) {
    adoptLocalPaneShell(targetId, arrival.pane, source?.local?.shellId ?? sourceId)
  } else {
    if (typeof window.electronAPI.sshMergeTab !== 'function') return { ok: false, error: '앱을 다시 시작한 뒤에 쓸 수 있습니다.' }
    const merged = await window.electronAPI.sshMergeTab(sourceId, targetId)
    if (!merged.success || !merged.streamId) return { ok: false, error: merged.error || '탭을 병합하지 못했습니다.' }
    // From the answer on the shell's output arrives as the target tab's split output. It is held
    // from this tick, and the screen the tab showed up to here is drawn before it.
    expectIncomingShell(targetId, arrival.pane, merged.streamId)
    setIncomingScreen(targetId, arrival.pane, (await captureDrawnSnapshot(sourceId)) ?? '')
    // The rest of the tab ends as it does when a tab is closed
    if (source?.statsId) useStatsStore.getState().endRecord(source.statsId)
    useSftpStore.getState().removeSession(sourceId)
  }

  const store = useTerminalStore.getState()
  const target = store.terminals.get(targetId)
  store.updateTerminalMeta(targetId, {
    isSplit: true,
    splitTree: arrival.tree,
    paneSeq: arrival.seq,
    paneArrival: { pane: arrival.pane, seq: (target?.paneArrival?.seq ?? 0) + 1 }
  })
  store.removeTerminal(sourceId)
  useTerminalStore.getState().focusTerminal(targetId)
  requestAnimationFrame(() => window.dispatchEvent(new Event('resize')))
  return { ok: true }
}
