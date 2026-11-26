// The tabs open when an update is installed, written down so they can be opened again after it
// (docs/plan/2026-11-18-restore-tabs-after-update.md). What is kept: which saved session a tab came
// from, how it was laid out and the folders it was in. Never passwords or what was on the screen.
// The main process keeps the record encrypted; it is checked here again when it comes back.

import type { TerminalInfo, LayoutState } from '../stores/terminalStore'
import { MAIN_PANE, SSH_MAX_PANES, paneIds, type PaneTabKind, type SplitNode } from './splitTree'
import { MAX_SCREENS } from './screenPanes'

export const RESTORE_VERSION = 1
// Applies to saved layouts only. The live local split tree has no pane-count limit.
export const LOCAL_RESTORE_MAX_PANES = 64
const LOCAL_RESTORE_MAX_DEPTH = LOCAL_RESTORE_MAX_PANES - 1
const MAX_OTHER_TABS = 50
const MAX_TEXT = 500
const LOCAL_SHELL_ID = /^local:\d{1,9}$/

export type RestoreTab =
  | { kind: 'ssh'; savedSessionId: string; title?: string; color?: string; splitTree?: SplitNode; paneSeq?: number; currentPath?: string; sftpPath?: string; workGroup?: string }
  /** Not saved as a session: shown so the user can connect again (no password is kept) */
  | { kind: 'quick'; title?: string; host: string; port: number; username: string; authType?: 'password' | 'privateKey'; privateKeyPath?: string; workGroup?: string }
  | { kind: 'local'; title?: string; splitTree?: SplitNode; paneSeq?: number; cwd?: string; workspaceLabel?: string; agents?: RestoreAgent[]; shellId?: string }
  /** A DB tab opened with a saved account, on the SSH tab at index `parent` */
  | { kind: 'db'; parent: number; savedAccountId: string; title?: string }

/**
 * A Claude Code or Codex that ran in a pane of a local tab: its conversation is resumed (--resume), or,
 * without one to resume (never talked to, or its transcript is gone), the same agent starts fresh
 */
export interface RestoreAgent {
  pane: string
  agent: 'claude' | 'codex'
  sessionId?: string
  claudeProfileId?: string
  /** The pane showed its agent as a chat: it opens as a chat again once the agent is back */
  chat?: true
}

export interface RestoreRecord {
  version: number
  tabs: RestoreTab[]
  /** Index of the tab in front */
  active?: number
  /** The screen divided into two sides: indexes of the tabs on each side */
  split?: {
    direction: 'horizontal' | 'vertical'; primary: number[]; secondary: number[]; primaryActive?: number; secondaryActive?: number; focus?: 'primary' | 'secondary'
    /** Every screen (up to four, lib/screenPanes.ts): tab indexes, each screen's front tab, shares, the focused screen.
     *  primary / secondary above are the first two, as records made before kept them */
    panes?: number[][]; actives?: Array<number | null>; sizes?: number[]; focusPane?: number
  }
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
  /** The agent sessions running in a local tab's panes (from their usage reports) */
  agentsOf?: (tabId: string) => RestoreAgent[]
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

function tabOf(info: TerminalInfo, sftpPath: string | null, agents: RestoreAgent[] = []): RestoreTab | null {
  const title = text(info.title)
  const splitTree = withoutVacants(info.splitTree)
  const paneSeq = splitTree ? info.paneSeq : undefined
  if (info.local) {
    const kept = agents.filter(isRestoreAgent).slice(0, LOCAL_RESTORE_MAX_PANES)
    // The tab's own shell: when the session host kept it through an update, the tab comes back with it
    // instead of being opened again (lib/localShellAdopt.ts)
    const shellId = info.local.shellId ?? info.id
    return {
      kind: 'local', title, splitTree, paneSeq, cwd: path(info.local.cwd), workspaceLabel: text(info.local.workspaceLabel), ...(kept.length ? { agents: kept } : {}),
      ...(LOCAL_SHELL_ID.test(shellId ?? '') ? { shellId } : {})
    }
  }
  const config = info.connectConfig
  if (!config) return null
  const workGroup = path(config.workGroup)
  if (config.savedSessionId) {
    return {
      kind: 'ssh', savedSessionId: config.savedSessionId, title, color: text(info.color, 50), splitTree, paneSeq,
      currentPath: text(info.currentPath), sftpPath: sftpPath ? text(sftpPath) : undefined, workGroup
    }
  }
  return {
    kind: 'quick', title, host: config.host, port: Number(config.port) || 22, username: config.username,
    authType: config.authType, privateKeyPath: text(config.privateKeyPath), workGroup
  }
}

/** The tabs in strip order, then popped-out ones. */
export function buildRestoreRecord(source: RecordSource): RestoreRecord {
  const tabs: RestoreTab[] = []
  const indexOf = new Map<string, number>()
  const dbTabs: Array<[string, TerminalInfo]> = []
  let otherTabs = 0
  const append = (tab: RestoreTab, id?: string) => {
    if (tab.kind !== 'local') {
      if (otherTabs >= MAX_OTHER_TABS) return
      otherTabs++
    }
    if (id !== undefined) indexOf.set(id, tabs.length)
    tabs.push(tab)
  }
  for (const [id, info] of source.terminals) {
    if (info.browser) continue
    if (info.db) { dbTabs.push([id, info]); continue }
    const tab = tabOf(info, source.sftpPathOf(id), info.local ? source.agentsOf?.(id) : undefined)
    if (tab) append(tab, id)
  }
  for (const detached of source.detached) {
    const tab = detached.connectConfig ? tabOf({ ...detached, id: '', host: '', username: '', connected: true }, null) : null
    if (tab) append(tab)
  }
  // DB tabs come after the tab whose connection they use, so it is open by then
  for (const [id, info] of dbTabs) {
    const parent = info.db ? indexOf.get(info.db.sshSessionId) : undefined
    if (parent === undefined || !info.db?.savedAccountId) continue
    append({ kind: 'db', parent, savedAccountId: info.db.savedAccountId, title: text(info.title) }, id)
  }
  const record: RestoreRecord = { version: RESTORE_VERSION, tabs }
  const active = source.activeId ? indexOf.get(source.activeId) : undefined
  if (active !== undefined) record.active = active
  const { layout } = source
  if (layout.mode === 'split' && layout.panes.length > 1) {
    const indexes = (ids: string[]) => ids.map(id => indexOf.get(id)).filter((index): index is number => index !== undefined)
    const screens = layout.panes.map(pane => ({ tabs: indexes(pane.terminalIds), active: pane.activeTerminalId ? indexOf.get(pane.activeTerminalId) ?? null : null }))
    const kept = screens.filter(screen => screen.tabs.length > 0)
    if (kept.length > 1) {
      const focusPane = Math.max(0, kept.indexOf(screens[layout.activePane ?? 0]))
      record.split = {
        direction: layout.direction, primary: kept[0].tabs, secondary: kept[1].tabs,
        primaryActive: kept[0].active ?? undefined, secondaryActive: kept[1].active ?? undefined,
        focus: focusPane === 0 ? 'primary' : 'secondary',
        panes: kept.map(screen => screen.tabs), actives: kept.map(screen => screen.active), sizes: kept.map(screen => layout.sizes[screens.indexOf(screen)] ?? 1), focusPane
      }
    }
  }
  return record
}

const PANE_ID = /^(main|split-\d{1,6})$/
const MAX_PANE_SEQ = 999_999

export function readPaneSeq(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= MAX_PANE_SEQ ? value : undefined
}

const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const isRestoreAgent = (value: unknown): value is RestoreAgent => {
  const a = value as Record<string, unknown> | null
  return !!a && typeof a.pane === 'string' && PANE_ID.test(a.pane) && (a.agent === 'claude' || a.agent === 'codex')
    && (a.sessionId === undefined || (typeof a.sessionId === 'string' && SESSION_ID.test(a.sessionId)))
    && (a.claudeProfileId === undefined || (a.agent === 'claude' && typeof a.claudeProfileId === 'string' && SESSION_ID.test(a.claudeProfileId)))
    && (a.chat === undefined || a.chat === true)
}

/** A split tree read back from storage: valid pane ids, each once, the main pane among them; undefined otherwise */
export function readTree(value: unknown, kind: PaneTabKind = 'ssh'): SplitNode | undefined {
  const maxPanes = kind === 'local' ? LOCAL_RESTORE_MAX_PANES : SSH_MAX_PANES
  const maxDepth = kind === 'local' ? LOCAL_RESTORE_MAX_DEPTH : SSH_MAX_PANES
  const panes = new Set<string>()
  const read = (node: unknown, depth: number): SplitNode | null => {
    if (!node || typeof node !== 'object' || depth > maxDepth) return null
    const n = node as Record<string, unknown>
    if (n.kind === 'pane') {
      if (typeof n.pane !== 'string' || !PANE_ID.test(n.pane) || panes.has(n.pane) || panes.size >= maxPanes) return null
      panes.add(n.pane)
      return { kind: 'pane', pane: n.pane }
    }
    if (n.kind !== 'split' || (n.axis !== 'row' && n.axis !== 'col')) return null
    const ratio = typeof n.ratio === 'number' && n.ratio >= 0.1 && n.ratio <= 0.9 ? n.ratio : 0.5
    const first = read(n.first, depth + 1)
    if (!first) return null
    const second = read(n.second, depth + 1)
    return second ? { kind: 'split', axis: n.axis, ratio, first, second } : null
  }
  const tree = read(value, 0)
  return tree?.kind === 'split' && panes.has(MAIN_PANE) ? tree : undefined
}

const path = (value: unknown): string | undefined => {
  const p = text(value, 1024)
  return p && !hasControl(p) ? p : undefined
}

function readTab(value: unknown, index: number): RestoreTab | null {
  if (!value || typeof value !== 'object') return null
  const t = value as Record<string, unknown>
  const title = text(t.title)
  const tree = t.kind === 'ssh' || t.kind === 'local' ? readTree(t.splitTree, t.kind) : undefined
  const paneSeq = tree ? readPaneSeq(t.paneSeq) : undefined
  switch (t.kind) {
    case 'ssh': {
      const savedSessionId = text(t.savedSessionId, 100)
      if (!savedSessionId) return null
      const color = text(t.color, 50)
      return { kind: 'ssh', savedSessionId, title, color: color && /^#[0-9a-f]{3,8}$/i.test(color) ? color : undefined, splitTree: tree, paneSeq, currentPath: path(t.currentPath), sftpPath: path(t.sftpPath), workGroup: path(t.workGroup) }
    }
    case 'quick': {
      const host = text(t.host, 255)
      const username = text(t.username, 255)
      const port = typeof t.port === 'number' && Number.isInteger(t.port) && t.port > 0 && t.port < 65536 ? t.port : 22
      if (!host || !username || hasControl(host) || hasControl(username)) return null
      const authType = t.authType === 'privateKey' ? 'privateKey' : 'password'
      return { kind: 'quick', title, host, port, username, authType, privateKeyPath: authType === 'privateKey' ? path(t.privateKeyPath) : undefined, workGroup: path(t.workGroup) }
    }
    case 'local': {
      // Only panes the tab has (the main pane, or a pane of its tree), each once
      const panes = new Set(tree ? paneIds(tree) : [MAIN_PANE])
      const seen = new Set<string>()
      const agents = (Array.isArray(t.agents) ? t.agents : []).slice(0, LOCAL_RESTORE_MAX_PANES * 2)
        .filter(isRestoreAgent).filter(a => panes.has(a.pane) && !seen.has(a.pane) && seen.add(a.pane))
        .map(({ pane, agent, sessionId, chat, claudeProfileId }) => ({ pane, agent, ...(sessionId && { sessionId }),
          ...(chat && { chat }), ...(claudeProfileId && { claudeProfileId }) }))
      const shellId = typeof t.shellId === 'string' && LOCAL_SHELL_ID.test(t.shellId) ? t.shellId : undefined
      return { kind: 'local', title, splitTree: tree, paneSeq, cwd: path(t.cwd), workspaceLabel: text(t.workspaceLabel), ...(agents.length ? { agents } : {}), ...(shellId ? { shellId } : {}) }
    }
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
  const tabs: RestoreTab[] = []
  const map = new Map<number, number>()
  let otherTabs = 0
  r.tabs.forEach((value, index) => {
    const tab = readTab(value, index)
    if (!tab || (tab.kind !== 'local' && otherTabs >= MAX_OTHER_TABS)) return
    if (tab.kind === 'db') {
      const parent = map.get(tab.parent)
      if (parent === undefined || tabs[parent].kind !== 'ssh') return
      tab.parent = parent
    }
    if (tab.kind !== 'local') otherTabs++
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
      // Three or four screens (records made since screens went past two)
      if (Array.isArray(split.panes) && split.panes.length >= 2 && split.panes.length <= MAX_SCREENS && split.panes.every(Array.isArray)) {
        const used = new Set<number>()
        const panes = (split.panes as unknown[][]).map(list => list.map(at).filter((index): index is number => index !== undefined && !used.has(index) && (used.add(index), true)))
        if (panes.every(pane => pane.length > 0)) {
          const actives = Array.isArray(split.actives) ? split.actives : []
          const sizes = Array.isArray(split.sizes) && split.sizes.length === panes.length && split.sizes.every(size => typeof size === 'number' && size > 0 && size <= 1) ? split.sizes as number[] : undefined
          const focusPane = typeof split.focusPane === 'number' && Number.isInteger(split.focusPane) && split.focusPane >= 0 && split.focusPane < panes.length ? split.focusPane : 0
          Object.assign(record.split, { panes, actives: panes.map((pane, index) => { const active = at(actives[index]); return active !== undefined && pane.includes(active) ? active : null }), sizes, focusPane })
        }
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
/** A local tab whose shell the session host kept through the update: it is open again already */
export const isKeptLocalTab = (tab: RestoreTab, kept: ReadonlySet<string>): boolean =>
  tab.kind === 'local' && !!tab.shellId && kept.has(tab.shellId)

export const reopenable = (record: RestoreRecord, kept: ReadonlySet<string> = new Set()) =>
  record.tabs.filter(tab => tab.kind !== 'quick' && !isKeptLocalTab(tab, kept))
