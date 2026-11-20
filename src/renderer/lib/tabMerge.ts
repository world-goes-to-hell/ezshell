// Which tabs may be merged into a pane of another tab, and why not when they may not.
// Only tabs of the same session: the same saved session (opened twice, duplicated, or a pane moved
// out to a tab), the same server and account for quick connects, or two local tabs of the same folder.

import type { TerminalInfo } from '../stores/terminalStore'
import { MAX_PANES, leafCount, singlePane, type SplitAxis } from './splitTree'
import { pathKey } from './localWorkspaceTree'

export const MERGE_BLOCKED_TITLE = '병합할 수 없습니다'

type Tabs = ReadonlyMap<string, TerminalInfo>

const label = (tab: TerminalInfo) => tab.title || `${tab.username}@${tab.host}`
const localFolderKey = (tab: TerminalInfo) => tab.local?.cwd ? pathKey(tab.local.cwd) : null

/** Both tabs come from the same session */
export function isSameSession(a: TerminalInfo, b: TerminalInfo): boolean {
  if (a.db || b.db || a.browser || b.browser) return false
  if (a.local || b.local) return Boolean(a.local && b.local && localFolderKey(a) === localFolderKey(b))
  const savedA = a.connectConfig?.savedSessionId
  const savedB = b.connectConfig?.savedSessionId
  if (savedA || savedB) return savedA === savedB
  // Quick connects have no saved session: the same account on the same server
  const login = (tab: TerminalInfo) => JSON.stringify([
    tab.connectConfig?.host ?? tab.host,
    Number(tab.connectConfig?.port) || 22,
    tab.connectConfig?.username ?? tab.username
  ])
  return login(a) === login(b)
}

/**
 * Why `sourceId` cannot become a pane of `targetId`; null when it can.
 * `hasPortForwards`: the source tab holds port forwards (asked from the main process).
 */
export function mergeBlock(tabs: Tabs, sourceId: string, targetId: string, hasPortForwards = false): string | null {
  const source = tabs.get(sourceId)
  const target = tabs.get(targetId)
  if (!source || !target) return '병합할 탭을 찾지 못했습니다.'
  if (sourceId === targetId) return '같은 탭에는 병합할 수 없습니다.'
  if (source.db || target.db) return 'DB 탭은 병합할 수 없습니다. 터미널 탭끼리만 한 탭의 칸으로 합칠 수 있습니다.'
  if (source.browser || target.browser) return '브라우저 탭은 화면 분할에서 나란히 열 수 있습니다.'
  if (source.local && target.local && localFolderKey(source) !== localFolderKey(target)) {
    return `같은 작업 폴더에서 연 로컬 탭만 병합할 수 있습니다.\n옮기는 탭 · ${source.local.cwd ?? '기본 폴더'}\n대상 탭 · ${target.local.cwd ?? '기본 폴더'}`
  }
  if (!isSameSession(source, target)) return '다른 세션의 탭은 병합할 수 없습니다. 같은 세션에서 연 탭만 한 탭의 칸으로 합칠 수 있습니다.'
  if (!source.connected || !target.connected) return '연결된 탭끼리만 병합할 수 있습니다.'
  if (source.splitTree) return '칸을 나눈 탭은 병합할 수 없습니다. 칸을 닫거나 탭으로 뺀 뒤에 다시 시도해 주세요.'
  const tree = target.splitTree ?? singlePane()
  // An empty place can be filled even when the tab is full
  const hasVacant = leafCount(tree) > countPanes(tree)
  if (!hasVacant && leafCount(tree) >= MAX_PANES) return `한 탭에는 ${MAX_PANES}칸까지 둘 수 있습니다.`
  for (const tab of tabs.values()) {
    if (tab.db?.sshSessionId === sourceId) return '이 탭의 연결을 쓰는 DB 탭이 있어 병합할 수 없습니다. DB 탭을 닫은 뒤에 다시 시도해 주세요.'
  }
  if (hasPortForwards) return '이 탭의 연결을 쓰는 포트 포워딩이 있어 병합할 수 없습니다. 포트 포워딩을 멈춘 뒤에 다시 시도해 주세요.'
  return null
}

function countPanes(node: NonNullable<TerminalInfo['splitTree']>): number {
  if (node.kind === 'split') return countPanes(node.first) + countPanes(node.second)
  return node.kind === 'pane' ? 1 : 0
}

export interface MergeChoice {
  id: string
  label: string
  /** Why this tab cannot take the source tab; null when it can */
  blocked: string | null
}

/** The other tabs of the same session, as the targets offered in the tab's menu */
export function mergeChoices(tabs: Tabs, sourceId: string): MergeChoice[] {
  const source = tabs.get(sourceId)
  if (!source || source.db || source.browser) return []
  const order = Array.from(tabs.keys())
  return order
    .filter(id => id !== sourceId)
    .map(id => ({ id, tab: tabs.get(id)! }))
    .filter(({ tab }) => isSameSession(source, tab))
    .map(({ id, tab }) => ({
      id,
      // Tabs of one session usually share a name: the position in the tab strip tells them apart
      label: `${label(tab)} (${order.indexOf(id) + 1}번째 탭)`,
      blocked: mergeBlock(tabs, sourceId, id)
    }))
}

const MIN_HALF_WIDTH_PX = 180
const MIN_HALF_HEIGHT_PX = 100

/** How a pane of this size is halved for the arriving shell: side by side when wide, else stacked. Null: too small. */
export function mergeAxis(width: number, height: number): SplitAxis | null {
  const canRow = width / 2 >= MIN_HALF_WIDTH_PX
  const canCol = height / 2 >= MIN_HALF_HEIGHT_PX
  if (canRow && (width >= height || !canCol)) return 'row'
  return canCol ? 'col' : null
}
