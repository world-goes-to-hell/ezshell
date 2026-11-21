// Opens the tabs of a restore record again, one after another (docs/plan/2026-11-18-restore-tabs-after-update.md).
// One at a time: the servers are not hit all at once, and host key questions do not pile up.

import { useTerminalStore } from '../stores/terminalStore'
import { useSftpStore } from '../stores/sftpStore'
import { useSessionStore } from '../stores/sessionStore'
import { cdCommand, type RestoreRecord, type RestoreTab } from './restoreTabs'

export interface RestoreDeps {
  /** Opens a tab of a saved session the way the sidebar does; the new tab's id, or why not */
  openSaved: (savedSessionId: string, workGroup?: string) => Promise<{ id?: string; error?: string }>
  /** Opens a local terminal tab; its id, or null */
  openLocal: (tab: Extract<RestoreTab, { kind: 'local' }>) => Promise<string | null>
  /** Tells how far it got */
  onProgress?: (done: number, total: number) => void
}

export interface RestoreOutcome {
  opened: number
  failed: Array<{ label: string; reason: string }>
  /** Quick connects: not opened, offered to the user with their login filled in */
  quick: Array<Extract<RestoreTab, { kind: 'quick' }>>
}

// After the shell and the session's own start script (one line every 300 ms after 500 ms) have run
const CD_DELAY_MS = 900
const SCRIPT_LINE_MS = 300

const labelOf = (tab: RestoreTab): string => {
  if (tab.title) return tab.title
  if (tab.kind === 'ssh') return useSessionStore.getState().sessions.find(s => s.id === tab.savedSessionId)?.name ?? '저장된 세션'
  if (tab.kind === 'quick') return `${tab.username}@${tab.host}`
  if (tab.kind === 'local') return '로컬 터미널'
  return 'DB 탭'
}

/** Title and panes as they were (each pane opens a shell of its own when it is drawn) */
function shapeTab(id: string, tab: Extract<RestoreTab, { kind: 'ssh' | 'local' }>): void {
  const store = useTerminalStore.getState()
  store.updateTerminalMeta(id, {
    ...(tab.title ? { title: tab.title } : {}),
    ...(tab.splitTree ? { isSplit: true, splitTree: tab.splitTree, paneSeq: tab.paneSeq } : {})
  })
}

function goBackToFolder(id: string, tab: Extract<RestoreTab, { kind: 'ssh' }>): void {
  const command = cdCommand(tab.currentPath)
  if (!command) return
  const session = useSessionStore.getState().sessions.find(s => s.id === tab.savedSessionId)
  const scriptLines = (session?.postConnectScript ?? '').split('\n').filter(line => line.trim() && !line.trim().startsWith('#')).length
  window.setTimeout(() => {
    // Still that tab, still connected
    if (useTerminalStore.getState().terminals.get(id)?.connected) window.electronAPI.sshSend(id, command)
  }, CD_DELAY_MS + scriptLines * SCRIPT_LINE_MS)
}

async function openDb(tab: Extract<RestoreTab, { kind: 'db' }>, parentId: string, parent: Extract<RestoreTab, { kind: 'ssh' }>): Promise<string | null> {
  const session = useSessionStore.getState().sessions.find(s => s.id === parent.savedSessionId)
  const account = session?.dbConnections?.find(a => a.id === tab.savedAccountId)
  if (!session || !account) throw new Error('저장된 DB 계정을 찾지 못했습니다.')
  if (typeof window.electronAPI.dbOpen !== 'function') throw new Error('앱을 다시 시작해 주세요.')
  const result = await window.electronAPI.dbOpen(parentId, session.name, { engine: account.engine, host: account.host, port: account.port },
    { user: account.user, password: account.password ?? '', database: account.database ?? '' }, 'tab')
  if (!result.success) throw new Error(result.error)
  if (!result.dbId) return null
  const id = `db:${result.dbId}`
  const title = tab.title ?? `${result.info.product} · ${account.database || account.user}`
  useTerminalStore.getState().addTerminal(id, {
    id, host: account.host, username: account.user, connected: true, title,
    db: { dbId: result.dbId, sshSessionId: parentId, label: account.label, savedAccountId: account.id }
  })
  return id
}

/** The two sides of the screen, when it was divided and is not now */
function layOut(record: RestoreRecord, ids: Array<string | null>): void {
  const store = useTerminalStore.getState()
  const at = (index: number | undefined) => (index === undefined ? null : ids[index] ?? null)
  const split = record.split
  // Every screen at once (records with the screen list: up to four screens and their shares)
  if (split?.panes && store.layout.mode !== 'split') {
    const panes = split.panes.map((pane, index) => {
      const terminalIds = pane.map(at).filter((id): id is string => !!id)
      const active = at(split.actives?.[index] ?? undefined)
      return { terminalIds, activeTerminalId: active && terminalIds.includes(active) ? active : terminalIds[0] ?? null }
    })
    if (panes.filter(pane => pane.terminalIds.length > 0).length > 1) {
      store.setLayout({ mode: 'split', direction: split.direction, panes, sizes: split.sizes, activePane: split.focusPane ?? 0 })
      const after = useTerminalStore.getState().layout
      const front = after.panes[after.activePane ?? 0]?.activeTerminalId
      if (front) useTerminalStore.getState().setActiveTerminal(front)
      return
    }
  }
  if (split && store.layout.mode !== 'split') {
    const secondary = split.secondary.map(at).filter((id): id is string => !!id)
    const primary = split.primary.map(at).filter((id): id is string => !!id)
    if (secondary.length > 0 && primary.length > 0) {
      store.splitWithSession(secondary[0], split.direction, 'secondary')
      for (const id of secondary.slice(1)) useTerminalStore.getState().moveTerminalBetweenPanes(id, 'primary', 'secondary')
      const primaryActive = at(split.primaryActive)
      const secondaryActive = at(split.secondaryActive)
      if (primaryActive && primary.includes(primaryActive)) useTerminalStore.getState().setActivePaneTerminal('primary', primaryActive)
      if (secondaryActive && secondary.includes(secondaryActive)) useTerminalStore.getState().setActivePaneTerminal('secondary', secondaryActive)
      useTerminalStore.getState().setActivePaneType(split.focus ?? 'primary')
      return
    }
  }
  const active = at(record.active)
  if (active) useTerminalStore.getState().focusTerminal(active)
}

export async function restoreTabs(record: RestoreRecord, deps: RestoreDeps): Promise<RestoreOutcome> {
  const outcome: RestoreOutcome = { opened: 0, failed: [], quick: [] }
  const ids: Array<string | null> = record.tabs.map(() => null)
  const total = record.tabs.filter(tab => tab.kind !== 'quick').length
  let done = 0
  for (const [index, tab] of record.tabs.entries()) {
    if (tab.kind === 'quick') { outcome.quick.push(tab); continue }
    try {
      if (tab.kind === 'ssh') {
        const opened = await deps.openSaved(tab.savedSessionId, tab.workGroup)
        if (!opened.id) throw new Error(opened.error || '연결하지 못했습니다.')
        ids[index] = opened.id
        shapeTab(opened.id, tab)
        if (tab.sftpPath) {
          useSftpStore.getState().setRemotePath(opened.id, tab.sftpPath)
          useSftpStore.getState().setOpen(opened.id, true)
        }
        goBackToFolder(opened.id, tab)
      } else if (tab.kind === 'local') {
        const id = await deps.openLocal(tab)
        if (!id) throw new Error('로컬 터미널을 열지 못했습니다.')
        ids[index] = id
        shapeTab(id, tab)
      } else {
        const parentId = ids[tab.parent]
        const parent = record.tabs[tab.parent]
        if (!parentId || parent.kind !== 'ssh') throw new Error('이 DB 탭이 쓰던 SSH 탭을 다시 열지 못했습니다.')
        ids[index] = await openDb(tab, parentId, parent)
      }
      outcome.opened += 1
    } catch (error) {
      outcome.failed.push({ label: labelOf(tab), reason: error instanceof Error ? error.message : String(error) })
    }
    done += 1
    deps.onProgress?.(done, total)
  }
  layOut(record, ids)
  return outcome
}
