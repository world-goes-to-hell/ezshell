import { create } from 'zustand'

export interface TerminalInfo {
  id: string
  host: string
  username: string
  connected: boolean
  title?: string
  hasActivity?: boolean
  currentPath?: string
  isSplit?: boolean
  splitDirection?: SplitDirection
  splitSlots?: string[]
  color?: string
  statsId?: string
}

export type SplitDirection = 'horizontal' | 'vertical' | 'quad' | 'tri-bottom' | 'tri-top' | 'tri-right' | 'tri-left'

// NEW: Pane state with multiple terminals
export interface PaneState {
  terminalIds: string[]          // 이 pane에 속한 터미널 ID들
  activeTerminalId: string | null // 이 pane에서 활성화된 터미널
}

export interface LayoutState {
  mode: 'single' | 'split'
  direction: SplitDirection
  primary: PaneState
  secondary: PaneState | null
  activePaneType: 'primary' | 'secondary' | null  // 현재 포커스된 pane
}

type SshDataHandler = (data: string) => void

interface TerminalState {
  terminals: Map<string, TerminalInfo>
  activeTerminalId: string | null
  isConnecting: boolean
  sshDataHandlers: Map<string, SshDataHandler>

  // Layout state for split view
  layout: LayoutState

  // Font settings
  fontSize: number
  fontFamily: string

  addTerminal: (sessionId: string, info: TerminalInfo) => void
  removeTerminal: (sessionId: string) => void
  setActiveTerminal: (sessionId: string | null) => void
  setConnecting: (connecting: boolean) => void
  setConnected: (sessionId: string) => void
  setDisconnected: (sessionId: string) => void
  updateTerminalTitle: (sessionId: string, title: string) => void
  updateTerminalMeta: (sessionId: string, meta: Partial<TerminalInfo>) => void
  setTerminalActivity: (sessionId: string, hasActivity: boolean) => void
  getTerminal: (sessionId: string) => TerminalInfo | undefined
  setCurrentPath: (sessionId: string, path: string) => void

  // Per-terminal split (same session, two shells)
  getSplitDirection: (sessionId: string) => SplitDirection | undefined
  setSplit: (sessionId: string, isSplit: boolean, direction?: SplitDirection, splitSlots?: string[]) => void

  // Layout management
  setLayout: (layout: Partial<LayoutState>) => void
  splitWithSession: (sessionId: string, direction: SplitDirection, position: 'primary' | 'secondary') => void
  closeSplit: () => void

  // Pane-level terminal management
  addTerminalToPane: (paneType: 'primary' | 'secondary', terminalId: string) => void
  removeTerminalFromPane: (paneType: 'primary' | 'secondary', terminalId: string) => void
  setActivePaneTerminal: (paneType: 'primary' | 'secondary', terminalId: string) => void
  moveTerminalBetweenPanes: (terminalId: string, fromPane: 'primary' | 'secondary', toPane: 'primary' | 'secondary') => void
  setActivePaneType: (paneType: 'primary' | 'secondary' | null) => void

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

const defaultLayout: LayoutState = {
  mode: 'single',
  direction: 'horizontal',
  primary: { terminalIds: [], activeTerminalId: null },
  secondary: null,
  activePaneType: null
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
  isConnecting: false,
  sshDataHandlers: sshDataHandlers,
  layout: { ...defaultLayout },
  fontSize: DEFAULT_FONT_SIZE,
  fontFamily: DEFAULT_FONT_FAMILY,

  addTerminal: (sessionId, info) => set((state) => {
    const newTerminals = new Map(state.terminals)
    newTerminals.set(sessionId, info)

    // Also add to layout's primary pane (if not in split mode, or if in single mode)
    const newLayout = { ...state.layout }
    if (!newLayout.primary.terminalIds.includes(sessionId)) {
      newLayout.primary = {
        terminalIds: [...newLayout.primary.terminalIds, sessionId],
        activeTerminalId: sessionId
      }
    }

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

    // If active terminal was removed, switch to another
    let newActiveId = state.activeTerminalId
    if (state.activeTerminalId === sessionId) {
      const remaining = Array.from(newTerminals.keys())
      newActiveId = remaining.length > 0 ? remaining[remaining.length - 1] : null
    }

    // Remove from panes as well
    let newLayout = { ...state.layout }
    const newPrimary = { ...newLayout.primary }
    newPrimary.terminalIds = newPrimary.terminalIds.filter(id => id !== sessionId)
    if (newPrimary.activeTerminalId === sessionId) {
      newPrimary.activeTerminalId = newPrimary.terminalIds[0] || null
    }
    newLayout.primary = newPrimary

    if (newLayout.secondary) {
      const newSecondary = { ...newLayout.secondary }
      newSecondary.terminalIds = newSecondary.terminalIds.filter(id => id !== sessionId)
      if (newSecondary.activeTerminalId === sessionId) {
        newSecondary.activeTerminalId = newSecondary.terminalIds[0] || null
      }

      // If secondary pane is now empty, close split
      if (newSecondary.terminalIds.length === 0) {
        newLayout = {
          mode: 'single',
          direction: 'horizontal',
          primary: newPrimary,
          secondary: null,
          activePaneType: null
        }
        if (newPrimary.activeTerminalId) {
          newActiveId = newPrimary.activeTerminalId
        }
      } else {
        newLayout.secondary = newSecondary
      }
    }

    // If primary is empty but secondary has terminals, move them to primary
    if (newLayout.primary.terminalIds.length === 0 && newLayout.secondary && newLayout.secondary.terminalIds.length > 0) {
      newLayout = {
        mode: 'single',
        direction: 'horizontal',
        primary: newLayout.secondary,
        secondary: null,
        activePaneType: null
      }
      newActiveId = newLayout.primary.activeTerminalId
    }

    return {
      terminals: newTerminals,
      activeTerminalId: newActiveId,
      layout: newLayout
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

    // If in split mode and clicking on a tab not in split view, close split
    let newLayout = state.layout
    if (state.layout.mode === 'split' && sessionId) {
      const isInPrimary = state.layout.primary.terminalIds.includes(sessionId)
      const isInSecondary = state.layout.secondary?.terminalIds.includes(sessionId) || false
      if (!isInPrimary && !isInSecondary) {
        // Close split view when switching to a terminal outside the split
        // Merge all terminals to primary
        const allTerminalIds = [
          ...state.layout.primary.terminalIds,
          ...(state.layout.secondary?.terminalIds || []),
          sessionId
        ].filter((id, index, self) => self.indexOf(id) === index) // dedupe
        newLayout = {
          mode: 'single',
          direction: 'horizontal',
          primary: { terminalIds: allTerminalIds, activeTerminalId: sessionId },
          secondary: null,
          activePaneType: null
        }
      }
    }

    return {
      activeTerminalId: sessionId,
      terminals: newTerminals,
      layout: newLayout
    }
  }),

  setConnecting: (connecting) => set({ isConnecting: connecting }),

  setConnected: (sessionId) => set((state) => {
    const terminal = state.terminals.get(sessionId)
    if (terminal) {
      const newTerminals = new Map(state.terminals)
      newTerminals.set(sessionId, { ...terminal, connected: true })
      return { terminals: newTerminals }
    }
    return state
  }),

  setDisconnected: (sessionId) => set((state) => {
    const terminal = state.terminals.get(sessionId)
    if (terminal) {
      const newTerminals = new Map(state.terminals)
      newTerminals.set(sessionId, { ...terminal, connected: false })
      return { terminals: newTerminals }
    }
    return state
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

  getSplitDirection: (sessionId) => {
    const terminal = get().terminals.get(sessionId)
    return terminal?.splitDirection
  },

  setSplit: (sessionId, isSplit, direction = 'horizontal', splitSlots?) => set((state) => {
    const terminal = state.terminals.get(sessionId)
    if (terminal) {
      const newTerminals = new Map(state.terminals)
      newTerminals.set(sessionId, {
        ...terminal,
        isSplit,
        splitDirection: isSplit ? direction : undefined,
        splitSlots: isSplit ? splitSlots : undefined
      })
      return { terminals: newTerminals }
    }
    return state
  }),

  setLayout: (layoutUpdate) => set((state) => ({
    layout: { ...state.layout, ...layoutUpdate }
  })),

  splitWithSession: (sessionId, direction, position) => set((state) => {
    const currentActive = state.activeTerminalId
    // Get ALL terminal IDs from the terminals Map (not just from layout)
    const allTerminalIds = Array.from(state.terminals.keys())
    // Other terminals = all terminals except the one being split off
    const otherTerminalIds = allTerminalIds.filter(id => id !== sessionId)

    if (position === 'secondary') {
      // Dropped session goes to secondary, others stay in primary
      const newLayout = {
        mode: 'split' as const,
        direction,
        primary: {
          terminalIds: otherTerminalIds.length > 0 ? otherTerminalIds : (currentActive && currentActive !== sessionId ? [currentActive] : []),
          activeTerminalId: currentActive !== sessionId ? currentActive : (otherTerminalIds[0] || null)
        },
        secondary: {
          terminalIds: [sessionId],
          activeTerminalId: sessionId
        },
        activePaneType: 'secondary' as const
      }
      return { layout: newLayout }
    } else {
      // Dropped session goes to primary, others go to secondary
      const newLayout = {
        mode: 'split' as const,
        direction,
        primary: {
          terminalIds: [sessionId],
          activeTerminalId: sessionId
        },
        secondary: {
          terminalIds: otherTerminalIds.length > 0 ? otherTerminalIds : (currentActive && currentActive !== sessionId ? [currentActive] : []),
          activeTerminalId: currentActive !== sessionId ? currentActive : (otherTerminalIds[0] || null)
        },
        activePaneType: 'primary' as const
      }
      return { layout: newLayout }
    }
  }),

  closeSplit: () => set((state) => {
    // Merge all terminals from both panes to primary
    const primaryIds = state.layout.primary.terminalIds
    const secondaryIds = state.layout.secondary?.terminalIds || []
    const allIds = [...primaryIds, ...secondaryIds]

    // Determine active terminal: prefer secondary's active, then primary's, then first available
    const activeId = state.layout.secondary?.activeTerminalId ||
                     state.layout.primary.activeTerminalId ||
                     allIds[0] || null

    return {
      layout: {
        mode: 'single',
        direction: 'horizontal',
        primary: { terminalIds: allIds, activeTerminalId: activeId },
        secondary: null,
        activePaneType: null
      },
      activeTerminalId: activeId
    }
  }),

  // Pane-level terminal management
  addTerminalToPane: (paneType, terminalId) => set((state) => {
    const newLayout = { ...state.layout }

    // Check if terminal exists in another pane - if so, remove it first (auto-move)
    if (paneType === 'secondary' && newLayout.primary.terminalIds.includes(terminalId)) {
      newLayout.primary = {
        ...newLayout.primary,
        terminalIds: newLayout.primary.terminalIds.filter(id => id !== terminalId),
        activeTerminalId: newLayout.primary.activeTerminalId === terminalId
          ? (newLayout.primary.terminalIds.filter(id => id !== terminalId)[0] || null)
          : newLayout.primary.activeTerminalId
      }
    } else if (paneType === 'primary' && newLayout.secondary?.terminalIds.includes(terminalId)) {
      newLayout.secondary = {
        ...newLayout.secondary,
        terminalIds: newLayout.secondary.terminalIds.filter(id => id !== terminalId),
        activeTerminalId: newLayout.secondary.activeTerminalId === terminalId
          ? (newLayout.secondary.terminalIds.filter(id => id !== terminalId)[0] || null)
          : newLayout.secondary.activeTerminalId
      }
    }

    // Add to target pane
    if (paneType === 'primary') {
      if (!newLayout.primary.terminalIds.includes(terminalId)) {
        newLayout.primary = {
          terminalIds: [...newLayout.primary.terminalIds, terminalId],
          activeTerminalId: terminalId
        }
      }
    } else if (paneType === 'secondary' && newLayout.secondary) {
      if (!newLayout.secondary.terminalIds.includes(terminalId)) {
        newLayout.secondary = {
          terminalIds: [...newLayout.secondary.terminalIds, terminalId],
          activeTerminalId: terminalId
        }
      }
    }

    // Check if source pane became empty - if so, close split
    if (newLayout.secondary && newLayout.secondary.terminalIds.length === 0) {
      return {
        layout: {
          mode: 'single',
          direction: 'horizontal',
          primary: newLayout.primary,
          secondary: null,
          activePaneType: null
        }
      }
    }
    if (newLayout.primary.terminalIds.length === 0 && newLayout.secondary) {
      return {
        layout: {
          mode: 'single',
          direction: 'horizontal',
          primary: newLayout.secondary,
          secondary: null,
          activePaneType: null
        }
      }
    }

    return { layout: newLayout }
  }),

  removeTerminalFromPane: (paneType, terminalId) => set((state) => {
    const newLayout = { ...state.layout }

    if (paneType === 'primary') {
      const newTerminalIds = newLayout.primary.terminalIds.filter(id => id !== terminalId)
      const newActiveId = newLayout.primary.activeTerminalId === terminalId
        ? (newTerminalIds[0] || null)
        : newLayout.primary.activeTerminalId
      newLayout.primary = { terminalIds: newTerminalIds, activeTerminalId: newActiveId }

      // If primary became empty, close split and move secondary to primary
      if (newTerminalIds.length === 0 && newLayout.secondary) {
        return {
          layout: {
            mode: 'single',
            direction: 'horizontal',
            primary: newLayout.secondary,
            secondary: null,
            activePaneType: null
          },
          activeTerminalId: newLayout.secondary.activeTerminalId
        }
      }
    } else if (paneType === 'secondary' && newLayout.secondary) {
      const newTerminalIds = newLayout.secondary.terminalIds.filter(id => id !== terminalId)
      const newActiveId = newLayout.secondary.activeTerminalId === terminalId
        ? (newTerminalIds[0] || null)
        : newLayout.secondary.activeTerminalId

      // If secondary became empty, close split
      if (newTerminalIds.length === 0) {
        return {
          layout: {
            mode: 'single',
            direction: 'horizontal',
            primary: newLayout.primary,
            secondary: null,
            activePaneType: null
          },
          activeTerminalId: newLayout.primary.activeTerminalId
        }
      }

      newLayout.secondary = { terminalIds: newTerminalIds, activeTerminalId: newActiveId }
    }

    return { layout: newLayout }
  }),

  setActivePaneTerminal: (paneType, terminalId) => set((state) => {
    const newLayout = { ...state.layout }

    if (paneType === 'primary' && newLayout.primary.terminalIds.includes(terminalId)) {
      newLayout.primary = { ...newLayout.primary, activeTerminalId: terminalId }
    } else if (paneType === 'secondary' && newLayout.secondary?.terminalIds.includes(terminalId)) {
      newLayout.secondary = { ...newLayout.secondary, activeTerminalId: terminalId }
    }

    return {
      layout: newLayout,
      activeTerminalId: terminalId
    }
  }),

  moveTerminalBetweenPanes: (terminalId, fromPane, toPane) => set((state) => {
    if (fromPane === toPane) return state

    const newLayout = { ...state.layout }

    // Remove from source pane
    if (fromPane === 'primary') {
      newLayout.primary = {
        ...newLayout.primary,
        terminalIds: newLayout.primary.terminalIds.filter(id => id !== terminalId),
        activeTerminalId: newLayout.primary.activeTerminalId === terminalId
          ? (newLayout.primary.terminalIds.filter(id => id !== terminalId)[0] || null)
          : newLayout.primary.activeTerminalId
      }
    } else if (newLayout.secondary) {
      newLayout.secondary = {
        ...newLayout.secondary,
        terminalIds: newLayout.secondary.terminalIds.filter(id => id !== terminalId),
        activeTerminalId: newLayout.secondary.activeTerminalId === terminalId
          ? (newLayout.secondary.terminalIds.filter(id => id !== terminalId)[0] || null)
          : newLayout.secondary.activeTerminalId
      }
    }

    // Add to target pane
    if (toPane === 'primary') {
      newLayout.primary = {
        terminalIds: [...newLayout.primary.terminalIds, terminalId],
        activeTerminalId: terminalId
      }
    } else if (newLayout.secondary) {
      newLayout.secondary = {
        terminalIds: [...newLayout.secondary.terminalIds, terminalId],
        activeTerminalId: terminalId
      }
    }

    // Check if source pane became empty
    if (newLayout.secondary && newLayout.secondary.terminalIds.length === 0) {
      return {
        layout: {
          mode: 'single',
          direction: 'horizontal',
          primary: newLayout.primary,
          secondary: null,
          activePaneType: null
        }
      }
    }
    if (newLayout.primary.terminalIds.length === 0 && newLayout.secondary) {
      return {
        layout: {
          mode: 'single',
          direction: 'horizontal',
          primary: newLayout.secondary,
          secondary: null,
          activePaneType: null
        }
      }
    }

    return { layout: newLayout, activePaneType: toPane }
  }),

  setActivePaneType: (paneType) => set((state) => ({
    layout: { ...state.layout, activePaneType: paneType }
  })),

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
