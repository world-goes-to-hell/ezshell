import { create } from 'zustand'
import { singlePane, splitPane, nextPaneSeq, paneId, panePath, isSplitTree, type SplitNode, type SplitAxis, type PaneId } from '../lib/splitTree'
import { takePendingSnapshot } from '../lib/terminalSnapshots'
import { findTabPane } from '../lib/sessionTabs'
import { addScreen, buildScreens, paneIndex, screenOfTab, screensOf, withoutTab, type PaneRef, type ScreenDirection, type ScreenLayout, type ScreenPane } from '../lib/screenPanes'
import { linkConnected, linkDisconnected, linkReconnecting } from '../lib/connectionLost'
import type { SSHConnectConfig } from '../hooks/useSSH'

export interface TerminalInfo {
  id: string
  host: string
  username: string
  connected: boolean
  title?: string
  hasActivity?: boolean
  currentPath?: string
  isSplit?: boolean
  /** How the tab's terminal area is divided into panes (lib/splitTree.ts); absent when it is one pane */
  splitTree?: SplitNode
  /** Last number used for a pane id in this tab; ids are not reused, so pane elements keep unique keys */
  paneSeq?: number
  /** Highlight the destination of a split or move once */
  paneArrival?: { pane: PaneId; seq: number; dividerPath?: string }
  color?: string
  statsId?: string
  // Config this tab connected with, kept in memory only so the tab can be duplicated
  connectConfig?: SSHConnectConfig
  /** Play the opening animation when a new SSH connection gets its first tab */
  revealOnConnect?: boolean
  /** Automatic reconnect in progress after the connection dropped */
  reconnect?: { attempt: number; maxAttempts: number } | null
  /** Why the connection could not be brought back, shown on the "연결 끊김" overlay */
  disconnectNote?: string | null
  /**
   * A database tab (src/dbClient) instead of a terminal: no shell, SFTP, log or duplicate.
   * `sshSessionId` is the tab whose SSH connection carries the tunnel.
   */
  db?: { dbId: string; sshSessionId: string; label?: string; /** The saved account it was opened with (opened again after an update) */ savedAccountId?: string }
  browser?: { group: string | null }
  /** A local terminal. A reassigned main shell can have a different id from its tab. */
  local?: { shell: string; shellId?: string; cwd?: string; workspaceLabel?: string }
}

export type SplitDirection = 'horizontal' | 'vertical' | 'quad' | 'tri-bottom' | 'tri-top' | 'tri-right' | 'tri-left'

// NEW: Pane state with multiple terminals
export interface PaneState {
  terminalIds: string[]          // 이 pane에 속한 터미널 ID들
  activeTerminalId: string | null // 이 pane에서 활성화된 터미널
}

/**
 * The screen split: up to four screens side by side (or one above the other), each with its own tab
 * strip (lib/screenPanes.ts). `primary` / `secondary` / `activePaneType` are views of the first two.
 */
export type LayoutState = ScreenLayout

type SshDataHandler = (data: string) => void

export interface TabStripPosition {
  screen: number
  targetId: string | null
  after: boolean
  visibleIds: readonly string[]
}

interface TerminalState {
  terminals: Map<string, TerminalInfo>
  activeTerminalId: string | null
  pendingSessionConnections: ReadonlyMap<string, number>
  sshDataHandlers: Map<string, SshDataHandler>

  // Layout state for split view
  layout: LayoutState

  // Font settings
  fontSize: number
  fontFamily: string

  addTerminal: (sessionId: string, info: TerminalInfo) => void
  removeTerminal: (sessionId: string) => void
  moveTabInStrip: (sessionId: string, position: TabStripPosition) => void
  /** Drop output buffered for a session whose screen now lives in another window */
  discardSshDataBuffer: (sessionId: string) => void
  setActiveTerminal: (sessionId: string | null) => void
  /** Latest focusTerminal call; the tab's terminal takes keyboard focus whenever seq grows */
  focusRequest: { sessionId: string; seq: number } | null
  /** Bring an open tab to the front from outside the tab bar, keeping a split view as it is */
  focusTerminal: (sessionId: string) => void
  changePendingSessionConnections: (savedSessionId: string, change: 1 | -1) => void
  setConnected: (sessionId: string) => void
  /** `note` says why; without one the reason already shown is kept (a close follows the failure message) */
  setDisconnected: (sessionId: string, note?: string) => void
  setReconnecting: (sessionId: string, attempt: number, maxAttempts: number) => void
  updateTerminalTitle: (sessionId: string, title: string) => void
  updateTerminalMeta: (sessionId: string, meta: Partial<TerminalInfo>) => void
  setTerminalActivity: (sessionId: string, hasActivity: boolean) => void
  getTerminal: (sessionId: string) => TerminalInfo | undefined
  setCurrentPath: (sessionId: string, path: string) => void

  // Per-terminal split (same session, two shells)
  /** Halves one pane of the tab: a new shell opens to its right ('row') or below it ('col') */
  splitTerminalPane: (sessionId: string, pane: PaneId, axis: SplitAxis, ratio?: number) => void
  /** A tree changed by closing, swapping, resizing or merging; one pane left ends the split */
  setSplitTree: (sessionId: string, tree: SplitNode, arrivedPane?: PaneId) => void

  // Layout management
  setLayout: (layout: Partial<LayoutState>) => void
  /** A new screen with this tab at the start ('primary') or end ('secondary'); nothing past four or the other way */
  splitWithSession: (sessionId: string, direction: SplitDirection, position: 'primary' | 'secondary') => void
  closeSplit: () => void

  // Screen-level terminal management: a screen by index, or 'primary' / 'secondary' for the first two
  addTerminalToPane: (pane: PaneRef, terminalId: string) => void
  removeTerminalFromPane: (pane: PaneRef, terminalId: string) => void
  setActivePaneTerminal: (pane: PaneRef, terminalId: string) => void
  moveTerminalBetweenPanes: (terminalId: string, fromPane: PaneRef, toPane: PaneRef) => void
  setActivePaneType: (pane: PaneRef | null) => void
  /** The screens' shares (dragging a divider) */
  setPaneSizes: (sizes: number[]) => void

  // Font management
  setFontSize: (size: number) => void
  setFontFamily: (family: string) => void
  increaseFontSize: () => void
  decreaseFontSize: () => void
  resetFontSize: () => void

  // SSH data handlers
  registerSshDataHandler: (sessionId: string, handler: SshDataHandler) => void
  unregisterSshDataHandler: (sessionId: string) => void
  dispatchSshData: (sessionId: string, data: string) => void
}

// Store handlers outside of zustand state to avoid re-renders
const sshDataHandlers = new Map<string, SshDataHandler>()
// Buffer SSH data when no handler is registered (e.g. during pane split transitions)
const sshDataBuffers = new Map<string, string[]>()

const defaultLayout: LayoutState = buildScreens({ panes: [] })

/** The layout for these screens, keeping every open tab in some screen (lib/screenPanes.ts) */
const screens = (state: { layout: LayoutState; terminals: Map<string, TerminalInfo> }, input: {
  panes: ScreenPane[]; sizes?: number[]; activePane?: number | null; direction?: ScreenDirection; allIds?: string[]
}): LayoutState => buildScreens({
  sizes: state.layout.sizes, activePane: state.layout.activePane, direction: state.layout.direction,
  allIds: [...state.terminals.keys()], ...input
})

function insertTab(ids: readonly string[], id: string, target: string | null, after: boolean): string[] {
  const next = ids.filter(item => item !== id)
  const index = target === null ? next.length : next.indexOf(target) + Number(after)
  next.splice(index, 0, id)
  return next
}

const DEFAULT_FONT_SIZE = 14
const MIN_FONT_SIZE = 10
const MAX_FONT_SIZE = 24
const DEFAULT_FONT_FAMILY = 'JetBrains Mono'

export const TERMINAL_FONTS = [
  { id: 'jetbrains-mono', name: 'JetBrains Mono', value: 'JetBrains Mono' },
  { id: 'd2coding', name: 'D2Coding (한글 코딩 서체)', value: 'D2Coding' },
  { id: 'consolas', name: 'Consolas', value: 'Consolas' },
  { id: 'fira-code', name: 'Fira Code', value: 'Fira Code' },
  { id: 'source-code-pro', name: 'Source Code Pro', value: 'Source Code Pro' },
  { id: 'monaco', name: 'Monaco', value: 'Monaco' },
  { id: 'menlo', name: 'Menlo', value: 'Menlo' },
  { id: 'courier-new', name: 'Courier New', value: 'Courier New' },
  { id: 'monospace', name: '시스템 기본', value: 'monospace' },
]

export const useTerminalStore = create<TerminalState>((set, get) => ({
  terminals: new Map(),
  activeTerminalId: null,
  pendingSessionConnections: new Map(),
  focusRequest: null,
  sshDataHandlers: sshDataHandlers,
  layout: { ...defaultLayout },
  fontSize: DEFAULT_FONT_SIZE,
  fontFamily: DEFAULT_FONT_FAMILY,

  addTerminal: (sessionId, info) => set((state) => {
    const newTerminals = new Map(state.terminals)
    newTerminals.set(sessionId, info)

    // A new tab joins the first screen (App moves it to the focused screen when the screen is split)
    const [first, ...rest] = state.layout.panes
    const panes = first && !first.terminalIds.includes(sessionId)
      ? [{ terminalIds: [...first.terminalIds, sessionId], activeTerminalId: sessionId }, ...rest]
      : state.layout.panes
    const newLayout = screens(state, { panes, allIds: [...newTerminals.keys()] })

    return {
      terminals: newTerminals,
      activeTerminalId: sessionId,
      layout: newLayout
    }
  }),

  removeTerminal: (sessionId) => set((state) => {
    const newTerminals = new Map(state.terminals)
    newTerminals.delete(sessionId)
    // Clean up SSH data buffer
    sshDataBuffers.delete(sessionId)
    // A screen handed over for a tab that never mounted (merged back, then closed at once) must not linger:
    // terminal output can contain secrets
    takePendingSnapshot(sessionId)

    const newLayout = screens(state, { panes: withoutTab(state.layout.panes, sessionId), allIds: [...newTerminals.keys()] })
    // The closed tab was in front: the front tab of the focused screen, else the last tab
    let newActiveId = state.activeTerminalId
    if (state.activeTerminalId === sessionId) {
      const focused = newLayout.panes[newLayout.activePane ?? 0]?.activeTerminalId
      const remaining = Array.from(newTerminals.keys())
      newActiveId = focused ?? (remaining.length > 0 ? remaining[remaining.length - 1] : null)
    }

    return {
      terminals: newTerminals,
      activeTerminalId: newActiveId,
      layout: newLayout
    }
  }),

  moveTabInStrip: (sessionId, { screen, targetId, after, visibleIds }) => set((state) => {
    const { terminals, layout } = state
    const source = screenOfTab(layout.panes, sessionId)
    const destination = layout.panes[screen]
    if (source < 0 || !destination || !terminals.has(sessionId) || targetId === sessionId ||
      (targetId !== null && (!terminals.has(targetId) || !destination.terminalIds.includes(targetId)))) return state

    // Keep other projects' tab slots: changing this strip must not move their groups.
    const visible = new Set(visibleIds)
    if (!visible.has(sessionId) || (targetId !== null && !visible.has(targetId))) return state
    const allIds = [...terminals.keys()]
    const visibleOrder = insertTab(allIds.filter(id => visible.has(id)), sessionId, targetId, after)
    let next = 0
    const orderedIds = allIds.map(id => visible.has(id) ? visibleOrder[next++] : id)
    const ordered = orderedIds.every((id, index) => id === allIds[index])
      ? terminals : new Map(orderedIds.map(id => [id, terminals.get(id)!]))

    const movingScreen = source !== screen
    const panes = layout.panes.map((pane, index) => {
      if (index === screen) return {
        terminalIds: layout.mode === 'single' ? orderedIds : insertTab(pane.terminalIds, sessionId, targetId, after),
        activeTerminalId: movingScreen ? sessionId : pane.activeTerminalId
      }
      if (index === source && movingScreen) return { ...pane, terminalIds: pane.terminalIds.filter(id => id !== sessionId) }
      return pane
    })
    return {
      terminals: ordered,
      layout: screens(state, { panes, activePane: movingScreen ? screen : layout.activePane }),
      activeTerminalId: movingScreen ? sessionId : state.activeTerminalId
    }
  }),

  setActiveTerminal: (sessionId) => set((state) => {
    // Clear activity indicator when becoming active
    let newTerminals = state.terminals
    if (sessionId) {
      const terminal = state.terminals.get(sessionId)
      if (terminal && terminal.hasActivity) {
        newTerminals = new Map(state.terminals)
        newTerminals.set(sessionId, { ...terminal, hasActivity: false })
      }
    }

    // A tab outside every screen of a split: the split closes, all tabs in one screen
    let newLayout = state.layout
    if (state.layout.mode === 'split' && sessionId && screenOfTab(state.layout.panes, sessionId) < 0) {
      const allIds = [...state.layout.panes.flatMap(pane => pane.terminalIds), sessionId]
      newLayout = screens(state, { panes: [{ terminalIds: allIds, activeTerminalId: sessionId }], activePane: null })
    }

    return {
      activeTerminalId: sessionId,
      terminals: newTerminals,
      layout: newLayout
    }
  }),

  focusTerminal: (sessionId) => {
    const { terminals, layout, setActiveTerminal, setActivePaneTerminal, setActivePaneType, setTerminalActivity } = get()
    if (!terminals.has(sessionId)) return

    const pane = findTabPane(layout, sessionId)
    // A screen index: 0 is the first screen, null means not in a split
    if (pane !== null) {
      // Same as clicking the tab in its pane; setActiveTerminal would not move the pane's own active tab
      setActivePaneTerminal(pane, sessionId)
      setActivePaneType(pane)
      if (terminals.get(sessionId)?.hasActivity) setTerminalActivity(sessionId, false)
    } else {
      setActiveTerminal(sessionId)
    }
    // Becoming active already focuses a terminal, but not when the tab was active all along
    set((state) => ({ focusRequest: { sessionId, seq: (state.focusRequest?.seq ?? 0) + 1 } }))
  },

  changePendingSessionConnections: (savedSessionId, change) => set((state) => {
    const pendingSessionConnections = new Map(state.pendingSessionConnections)
    const count = (pendingSessionConnections.get(savedSessionId) ?? 0) + change
    if (count > 0) pendingSessionConnections.set(savedSessionId, count)
    else pendingSessionConnections.delete(savedSessionId)
    return { pendingSessionConnections }
  }),

  setConnected: (sessionId) => set((state) => {
    const terminal = state.terminals.get(sessionId)
    if (terminal) {
      const newTerminals = new Map(state.terminals)
      newTerminals.set(sessionId, { ...terminal, ...linkConnected() })
      return { terminals: newTerminals }
    }
    return state
  }),

  setDisconnected: (sessionId, note) => set((state) => {
    const terminal = state.terminals.get(sessionId)
    if (terminal) {
      const newTerminals = new Map(state.terminals)
      newTerminals.set(sessionId, { ...terminal, ...linkDisconnected(terminal, note) })
      return { terminals: newTerminals }
    }
    return state
  }),

  setReconnecting: (sessionId, attempt, maxAttempts) => set((state) => {
    const terminal = state.terminals.get(sessionId)
    if (!terminal) return state
    const newTerminals = new Map(state.terminals)
    newTerminals.set(sessionId, { ...terminal, ...linkReconnecting(attempt, maxAttempts) })
    return { terminals: newTerminals }
  }),

  updateTerminalTitle: (sessionId, title) => set((state) => {
    const terminal = state.terminals.get(sessionId)
    if (terminal) {
      const newTerminals = new Map(state.terminals)
      newTerminals.set(sessionId, { ...terminal, title })
      return { terminals: newTerminals }
    }
    return state
  }),

  updateTerminalMeta: (sessionId, meta) => set((state) => {
    const terminal = state.terminals.get(sessionId)
    if (terminal) {
      const newTerminals = new Map(state.terminals)
      newTerminals.set(sessionId, { ...terminal, ...meta })
      return { terminals: newTerminals }
    }
    return state
  }),

  setTerminalActivity: (sessionId, hasActivity) => set((state) => {
    const terminal = state.terminals.get(sessionId)
    if (terminal) {
      const newTerminals = new Map(state.terminals)
      newTerminals.set(sessionId, { ...terminal, hasActivity })
      return { terminals: newTerminals }
    }
    return state
  }),

  getTerminal: (sessionId) => get().terminals.get(sessionId),

  setCurrentPath: (sessionId, path) => set((state) => {
    const terminal = state.terminals.get(sessionId)
    if (terminal) {
      const newTerminals = new Map(state.terminals)
      newTerminals.set(sessionId, { ...terminal, currentPath: path })
      return { terminals: newTerminals }
    }
    return state
  }),

  splitTerminalPane: (sessionId, pane, axis, ratio) => set((state) => {
    const terminal = state.terminals.get(sessionId)
    if (!terminal) return state
    const tree = terminal.splitTree ?? singlePane()
    const seq = nextPaneSeq(tree, terminal.paneSeq ?? 0)
    const newPane = paneId(seq)
    const next = splitPane(tree, pane, axis, newPane, ratio)
    if (next === tree) return state
    const newTerminals = new Map(state.terminals)
    newTerminals.set(sessionId, {
      ...terminal,
      isSplit: true,
      splitTree: next,
      paneSeq: seq,
      paneArrival: { pane: newPane, seq: (terminal.paneArrival?.seq ?? 0) + 1, dividerPath: panePath(tree, pane) }
    })
    return { terminals: newTerminals }
  }),

  setSplitTree: (sessionId, tree, arrivedPane) => set((state) => {
    const terminal = state.terminals.get(sessionId)
    if (!terminal) return state
    const isSplit = isSplitTree(tree)
    const newTerminals = new Map(state.terminals)
    newTerminals.set(sessionId, {
      ...terminal,
      isSplit,
      splitTree: isSplit ? tree : undefined,
      paneArrival: arrivedPane ? { pane: arrivedPane, seq: (terminal.paneArrival?.seq ?? 0) + 1 } : undefined
    })
    return { terminals: newTerminals }
  }),

  setLayout: (update) => set((state) => {
    // Written the old way (primary / secondary): the screens are read from those
    const merged = { ...state.layout, ...update }
    const panes = update.panes ?? (update.primary || update.secondary !== undefined || update.mode
      ? screensOf({ mode: merged.mode, primary: merged.primary, secondary: merged.secondary })
      : state.layout.panes)
    const activePane = update.activePane !== undefined ? update.activePane
      : update.activePaneType !== undefined ? (update.activePaneType === null ? null : paneIndex(update.activePaneType))
      : merged.activePane
    return { layout: screens(state, { panes, sizes: merged.sizes, activePane, direction: merged.direction as ScreenDirection }) }
  }),

  splitWithSession: (sessionId, direction, position) => set((state) => {
    // A new screen at the start ('primary') or end ('secondary'), up to four, all one way
    const way: ScreenDirection = direction === 'vertical' ? 'vertical' : 'horizontal'
    const added = addScreen(state.layout, sessionId, position === 'primary' ? 'start' : 'end', way)
    if (!added) return state
    return { layout: screens(state, { ...added, direction: way }), activeTerminalId: sessionId }
  }),

  closeSplit: () => set((state) => {
    const { panes, activePane } = state.layout
    const allIds = panes.flatMap(pane => pane.terminalIds)
    const activeId = panes[activePane ?? 0]?.activeTerminalId || panes[0]?.activeTerminalId || allIds[0] || null
    return {
      layout: screens(state, { panes: [{ terminalIds: allIds, activeTerminalId: activeId }], activePane: null }),
      activeTerminalId: activeId
    }
  }),

  // Pane-level terminal management (a screen by index, or 'primary' / 'secondary' for the first two)
  addTerminalToPane: (paneRef, terminalId) => set((state) => {
    const index = paneIndex(paneRef)
    if (index >= state.layout.panes.length) return state
    const panes = withoutTab(state.layout.panes, terminalId)
      .map((pane, at) => (at === index ? { terminalIds: [...pane.terminalIds, terminalId], activeTerminalId: terminalId } : pane))
    return { layout: screens(state, { panes }) }
  }),

  removeTerminalFromPane: (paneRef, terminalId) => set((state) => {
    const index = paneIndex(paneRef)
    const panes = state.layout.panes.map((pane, at) => (at === index ? { ...pane, terminalIds: pane.terminalIds.filter(id => id !== terminalId) } : pane))
    // Taken out of the screens on purpose (closing it): not put back into the first screen
    const layout = buildScreens({ panes, sizes: state.layout.sizes, activePane: state.layout.activePane, direction: state.layout.direction })
    const focused = layout.panes[layout.activePane ?? 0]
    return { layout, activeTerminalId: focused?.activeTerminalId ?? state.activeTerminalId }
  }),

  setActivePaneTerminal: (paneRef, terminalId) => set((state) => {
    const index = paneIndex(paneRef)
    const panes = state.layout.panes.map((pane, at) => (at === index && pane.terminalIds.includes(terminalId) ? { ...pane, activeTerminalId: terminalId } : pane))
    return { layout: screens(state, { panes }), activeTerminalId: terminalId }
  }),

  moveTerminalBetweenPanes: (terminalId, _fromPane, toPaneRef) => set((state) => {
    const to = paneIndex(toPaneRef)
    if (to >= state.layout.panes.length || state.layout.panes[to].terminalIds.includes(terminalId)) return state
    const panes = withoutTab(state.layout.panes, terminalId)
      .map((pane, at) => (at === to ? { terminalIds: [...pane.terminalIds, terminalId], activeTerminalId: terminalId } : pane))
    return { layout: screens(state, { panes, activePane: to }) }
  }),

  setActivePaneType: (paneRef) => set((state) => ({
    layout: screens(state, { panes: state.layout.panes, activePane: paneRef === null ? null : paneIndex(paneRef) })
  })),

  setPaneSizes: (sizes) => set((state) => ({ layout: screens(state, { panes: state.layout.panes, sizes }) })),

  registerSshDataHandler: (sessionId, handler) => {
    sshDataHandlers.set(sessionId, handler)
    // Flush any buffered data that arrived while handler was unregistered
    const buffer = sshDataBuffers.get(sessionId)
    if (buffer && buffer.length > 0) {
      buffer.forEach(d => handler(d))
      sshDataBuffers.delete(sessionId)
    }
  },

  unregisterSshDataHandler: (sessionId) => {
    sshDataHandlers.delete(sessionId)
  },

  discardSshDataBuffer: (sessionId) => {
    sshDataBuffers.delete(sessionId)
  },

  dispatchSshData: (sessionId, data) => {
    const handler = sshDataHandlers.get(sessionId)
    if (handler) {
      handler(data)
    } else {
      // Buffer data for when handler re-registers (e.g. during pane split transition)
      const buffer = sshDataBuffers.get(sessionId) || []
      buffer.push(data)
      sshDataBuffers.set(sessionId, buffer)
    }
    // Mark activity for inactive terminals
    const state = get()
    if (sessionId !== state.activeTerminalId) {
      const terminal = state.terminals.get(sessionId)
      if (terminal && !terminal.hasActivity) {
        const newTerminals = new Map(state.terminals)
        newTerminals.set(sessionId, { ...terminal, hasActivity: true })
        set({ terminals: newTerminals })
      }
    }
  },

  setFontSize: (size) => {
    const clampedSize = Math.max(MIN_FONT_SIZE, Math.min(MAX_FONT_SIZE, size))
    set({ fontSize: clampedSize })
    // Save to settings file (merge with existing settings)
    window.electronAPI?.loadSettings().then((settings: Record<string, unknown>) => {
      window.electronAPI?.saveSettings({ ...settings, terminalFontSize: clampedSize })
    }).catch((e: Error) => {
      console.warn('Failed to save font size:', e)
    })
    // Dispatch custom event for terminals to react
    window.dispatchEvent(new CustomEvent('terminal-font-size-changed', { detail: { fontSize: clampedSize } }))
  },

  setFontFamily: (family) => {
    set({ fontFamily: family })
    // Save to settings file (merge with existing settings)
    window.electronAPI?.loadSettings().then((settings: Record<string, unknown>) => {
      window.electronAPI?.saveSettings({ ...settings, terminalFontFamily: family })
    }).catch((e: Error) => {
      console.warn('Failed to save font family:', e)
    })
    // Dispatch custom event for terminals to react
    window.dispatchEvent(new CustomEvent('terminal-font-family-changed', { detail: { fontFamily: family } }))
  },

  increaseFontSize: () => {
    const currentSize = get().fontSize
    const newSize = Math.min(MAX_FONT_SIZE, currentSize + 2)
    get().setFontSize(newSize)
  },

  decreaseFontSize: () => {
    const currentSize = get().fontSize
    const newSize = Math.max(MIN_FONT_SIZE, currentSize - 2)
    get().setFontSize(newSize)
  },

  resetFontSize: () => {
    get().setFontSize(DEFAULT_FONT_SIZE)
  }
}))
