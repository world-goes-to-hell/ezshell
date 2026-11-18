// The tabs open when an update is installed, written down so they can be opened again after it
// (docs/plan/2026-11-18-restore-tabs-after-update.md). What is kept: which saved session a tab came
// from, how it was laid out and the folders it was in. Never passwords or what was on the screen.
// The main process keeps the record encrypted; it is checked here again when it comes back.

import type { TerminalInfo, LayoutState } from '../stores/terminalStore'
import { MAIN_PANE, MAX_PANES, leafCount, type SplitNode } from './splitTree'

export const RESTORE_VERSION = 1
const MAX_TABS = 50
const MAX_TEXT = 500

export type RestoreTab =
  | { kind: 'ssh'; savedSessionId: string; title?: string; color?: string; splitTree?: SplitNode; paneSeq?: number; currentPath?: string; sftpPath?: string }
  /** Not saved as a session: shown so the user can connect again (no password is kept) */
  | { kind: 'quick'; title?: string; host: string; port: number; username: string; authType?: 'password' | 'privateKey'; privateKeyPath?: string }
  | { kind: 'local'; title?: string; splitTree?: SplitNode; paneSeq?: number; cwd?: string; workspaceLabel?: string }
  /** A DB tab opened with a saved account, on the SSH tab at index `parent` */
  | { kind: 'db'; parent: number; savedAccountId: string; title?: string }

export interface RestoreRecord {
  version: number
  tabs: RestoreTab[]
  /** Index of the tab in front */
  active?: number
  /** The screen divided into two sides: indexes of the tabs on each side */
  split?: { direction: 'horizontal' | 'vertical'; primary: number[]; secondary: number[]; primaryActive?: number; secondaryActive?: number; focus?: 'primary' | 'secondary' }
}

/** A tab popped out to its own window (App keeps how it was opened) */
export interface DetachedTabSource {
  connectConfig?: TerminalInfo['connectConfig']
  color?: string
  title?: string
}

export interface RecordSource {
  terminals: ReadonlyMap<string, TerminalInfo>
  layout: LayoutState
  activeId: string | null
  /** The SFTP panel of a tab: its folder when open */
  sftpPathOf: (tabId: string) => string | null
  detached: DetachedTabSource[]
}

const text = (value: unknown, max = MAX_TEXT): string | undefined =>
  typeof value === 'string' && value.length > 0 && value.length <= max ? value : undefined
// eslint-disable-next-line no-control-regex
const hasControl = (value: string) => /[\u0000-\u001f\u007f\u0080-\u009f\u2028\u2029]/.test(value)

/** The tree without places left empty by panes moved out to tabs; undefined when one pane is left */
export function withoutVacants(tree: SplitNode | undefined): SplitNode | undefined {
  if (!tree) return undefined
  const strip = (node: SplitNode): SplitNode | null => {
    if (node.kind === 'vacant') return null
    if (node.kind === 'pane') return node
    const first = strip(node.first)
    const second = strip(node.second)
    if (!first) return second
    if (!second) return first
    return { ...node, first, second }
  }
  const kept = strip(tree)
  return kept && kept.kind === 'split' ? kept : undefined
}

function tabOf(info: TerminalInfo, sftpPath: string | null): RestoreTab | null {
  const title = text(info.title)
  const splitTree = withoutVacants(info.splitTree)
  const paneSeq = splitTree ? info.paneSeq : undefined
  if (info.local) return { kind: 'local', title, splitTree, paneSeq, cwd: path(info.local.cwd), workspaceLabel: text(info.local.workspaceLabel) }
  const config = info.connectConfig
  if (!config) return null
  if (config.savedSessionId) {
    return {
      kind: 'ssh', savedSessionId: config.savedSessionId, title, color: text(info.color, 50), splitTree, paneSeq,
      currentPath: text(info.currentPath), sftpPath: sftpPath ? text(sftpPath) : undefined
    }
  }
  return {
    kind: 'quick', title, host: config.host, port: Number(config.port) || 22, username: config.username,
    authType: config.authType, privateKeyPath: text(config.privateKeyPath)
  }
}

/** The tabs in strip order, then popped-out ones. */
export function buildRestoreRecord(source: RecordSource): RestoreRecord {
  const tabs: RestoreTab[] = []
  const indexOf = new Map<string, number>()
  const dbTabs: Array<[string, TerminalInfo]> = []
  for (const [id, info] of source.terminals) {
    if (info.db) { dbTabs.push([id, info]); continue }
    const tab = tabOf(info, source.sftpPathOf(id))
    if (!tab) continue
    indexOf.set(id, tabs.length)
    tabs.push(tab)
  }
  for (const detached of source.detached) {
    const tab = detached.connectConfig ? tabOf({ ...detached, id: '', host: '', username: '', connected: true }, null) : null
    if (tab) tabs.push(tab)
  }
  // DB tabs come after the tab whose connection they use, so it is open by then
  for (const [id, info] of dbTabs) {
    const parent = info.db ? indexOf.get(info.db.sshSessionId) : undefined
    if (parent === undefined || !info.db?.savedAccountId) continue
    indexOf.set(id, tabs.length)
    tabs.push({ kind: 'db', parent, savedAccountId: info.db.savedAccountId, title: text(info.title) })
  }
  const record: RestoreRecord = { version: RESTORE_VERSION, tabs: tabs.slice(0, MAX_TABS) }
  const active = source.activeId ? indexOf.get(source.activeId) : undefined
  if (active !== undefined) record.active = active
  const { layout } = source
  if (layout.mode === 'split' && layout.secondary && (layout.direction === 'horizontal' || layout.direction === 'vertical')) {
    const indexes = (ids: string[]) => ids.map(id => indexOf.get(id)).filter((index): index is number => index !== undefined)
    const primary = indexes(layout.primary.terminalIds)
    const secondary = indexes(layout.secondary.terminalIds)
    if (primary.length > 0 && secondary.length > 0) {
      record.split = {
        direction: layout.direction, primary, secondary,
        primaryActive: layout.primary.activeTerminalId ? indexOf.get(layout.primary.activeTerminalId) : undefined,
        secondaryActive: layout.secondary.activeTerminalId ? indexOf.get(layout.secondary.activeTerminalId) : undefined,
        focus: layout.activePaneType ?? undefined
      }
    }
  }
  return record
}

const PANE_ID = /^(main|split-\d{1,4})$/

function readTree(value: unknown): SplitNode | undefined {
  const read = (node: unknown, depth: number): SplitNode | null => {
    if (!node || typeof node !== 'object' || depth > MAX_PANES) return null
    const n = node as Record<string, unknown>
    if (n.kind === 'pane') return typeof n.pane === 'string' && PANE_ID.test(n.pane) ? { kind: 'pane', pane: n.pane } : null
    if (n.kind !== 'split' || (n.axis !== 'row' && n.axis !== 'col')) return null
    const ratio = typeof n.ratio === 'number' && n.ratio >= 0.1 && n.ratio <= 0.9 ? n.ratio : 0.5
    const first = read(n.first, depth + 1)
    const second = read(n.second, depth + 1)
    return first && second ? { kind: 'split', axis: n.axis, ratio, first, second } : null
  }
  const tree = read(value, 0)
  if (!tree || tree.kind !== 'split' || leafCount(tree) > MAX_PANES) return undefined
  // Every pane once, the tab's own shell among them
  const ids: string[] = []
  const collect = (node: SplitNode) => { if (node.kind === 'split') { collect(node.first); collect(node.second) } else ids.push(node.pane) }
  collect(tree)
  return ids.includes(MAIN_PANE) && new Set(ids).size === ids.length ? tree : undefined
}

const path = (value: unknown): string | undefined => {
  const p = text(value, 1024)
  return p && !hasControl(p) ? p : undefined
}

function readTab(value: unknown, index: number): RestoreTab | null {
  if (!value || typeof value !== 'object') return null
  const t = value as Record<string, unknown>
  const title = text(t.title)
  const tree = readTree(t.splitTree)
  const paneSeq = tree && typeof t.paneSeq === 'number' && Number.isInteger(t.paneSeq) && t.paneSeq >= 0 && t.paneSeq < 10000 ? t.paneSeq : undefined
  switch (t.kind) {
    case 'ssh': {
      const savedSessionId = text(t.savedSessionId, 100)
      if (!savedSessionId) return null
      const color = text(t.color, 50)
      return { kind: 'ssh', savedSessionId, title, color: color && /^#[0-9a-f]{3,8}$/i.test(color) ? color : undefined, splitTree: tree, paneSeq, currentPath: path(t.currentPath), sftpPath: path(t.sftpPath) }
    }
    case 'quick': {
      const host = text(t.host, 255)
      const username = text(t.username, 255)
      const port = typeof t.port === 'number' && Number.isInteger(t.port) && t.port > 0 && t.port < 65536 ? t.port : 22
      if (!host || !username || hasControl(host) || hasControl(username)) return null
      const authType = t.authType === 'privateKey' ? 'privateKey' : 'password'
      return { kind: 'quick', title, host, port, username, authType, privateKeyPath: authType === 'privateKey' ? path(t.privateKeyPath) : undefined }
    }
    case 'local':
      return { kind: 'local', title, splitTree: tree, paneSeq, cwd: path(t.cwd), workspaceLabel: text(t.workspaceLabel) }
    case 'db': {
      const savedAccountId = text(t.savedAccountId, 100)
      const parent = typeof t.parent === 'number' && Number.isInteger(t.parent) && t.parent >= 0 && t.parent < index ? t.parent : -1
      return savedAccountId && parent >= 0 ? { kind: 'db', parent, savedAccountId, title } : null
    }
    default:
      return null
  }
}

/** The record as it came back, checked; null when it is not one */
export function readRestoreRecord(value: unknown): RestoreRecord | null {
  if (!value || typeof value !== 'object') return null
  const r = value as Record<string, unknown>
  if (r.version !== RESTORE_VERSION || !Array.isArray(r.tabs)) return null
  // A tab that cannot be read is left out; the indexes of the others must still point at the same tabs
  const raw = r.tabs.slice(0, MAX_TABS)
  const tabs: RestoreTab[] = []
  const map = new Map<number, number>()
  raw.forEach((value, index) => {
    const tab = readTab(value, index)
    if (!tab) return
    if (tab.kind === 'db') {
      const parent = map.get(tab.parent)
      if (parent === undefined || tabs[parent].kind !== 'ssh') return
      tab.parent = parent
    }
    map.set(index, tabs.length)
    tabs.push(tab)
  })
  if (tabs.length === 0) return null
  const at = (value: unknown) => (typeof value === 'number' ? map.get(value) : undefined)
  const record: RestoreRecord = { version: RESTORE_VERSION, tabs }
  const active = at(r.active)
  if (active !== undefined) record.active = active
  const split = r.split as Record<string, unknown> | undefined
  if (split && (split.direction === 'horizontal' || split.direction === 'vertical') && Array.isArray(split.primary) && Array.isArray(split.secondary)) {
    const list = (values: unknown[]) => [...new Set(values.map(at).filter((index): index is number => index !== undefined))]
    const primary = list(split.primary)
    const secondary = list(split.secondary).filter(index => !primary.includes(index))
    if (primary.length > 0 && secondary.length > 0) {
      record.split = {
        direction: split.direction, primary, secondary,
        primaryActive: at(split.primaryActive), secondaryActive: at(split.secondaryActive),
        focus: split.focus === 'secondary' ? 'secondary' : split.focus === 'primary' ? 'primary' : undefined
      }
    }
  }
  return record
}

/**
 * The command that takes a shell back to `folder`, typed once after the tab connects again; null
 * when the folder cannot be written safely. `~` stays outside the quotes so the shell expands it.
 */
export function cdCommand(folder: string | undefined): string | null {
  if (!folder || hasControl(folder) || folder.length > 1024) return null
  const quote = (value: string) => `'${value.replace(/'/g, `'\\''`)}'`
  if (folder === '~') return 'cd ~\r'
  if (folder.startsWith('~/')) return `cd -- ~/${quote(folder.slice(2))}\r`
  if (folder.startsWith('/')) return `cd -- ${quote(folder)}\r`
  return null
}

/** What the notice counts: tabs that are opened again on their own */
export const reopenable = (record: RestoreRecord) => record.tabs.filter(tab => tab.kind !== 'quick')
