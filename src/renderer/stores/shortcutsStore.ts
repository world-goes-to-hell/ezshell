import { create } from 'zustand'

export type ShortcutCategory = 'general' | 'terminal' | 'sftp' | 'navigation'

export interface Shortcut {
  id: string
  keys: string[] // e.g., ['Ctrl', 'P']
  description: string
  category: ShortcutCategory
  action: string // action identifier
}

interface ShortcutsState {
  shortcuts: Shortcut[]
  customBindings: Record<string, string[]> // id -> custom keys
  getShortcut: (id: string) => Shortcut | undefined
  formatKeys: (keys: string[]) => string
  getEffectiveKeys: (id: string) => string[]
  setCustomBinding: (id: string, keys: string[]) => void
  resetCustomBinding: (id: string) => void
}

// Default shortcuts configuration
const defaultShortcuts: Shortcut[] = [
  // General
  {
    id: 'command-palette',
    keys: ['Ctrl', 'P'],
    description: 'Open Command Palette',
    category: 'general',
    action: 'openCommandPalette'
  },
  {
    id: 'new-connection',
    keys: ['Ctrl', 'N'],
    description: 'New Connection',
    category: 'general',
    action: 'newConnection'
  },
  {
    id: 'settings',
    keys: ['Ctrl', ','],
    description: 'Open Settings',
    category: 'general',
    action: 'openSettings'
  },
  {
    id: 'snippet-manager',
    keys: ['Ctrl', 'Shift', 'P'],
    description: 'Open Snippet Manager',
    category: 'general',
    action: 'openSnippetManager'
  },
  {
    id: 'fullscreen',
    keys: ['F11'],
    description: 'Toggle Fullscreen',
    category: 'general',
    action: 'toggleFullscreen'
  },
  {
    id: 'lock-app',
    keys: ['Ctrl', 'L'],
    description: 'Lock Application',
    category: 'general',
    action: 'lockApp'
  },
  {
    id: 'zen-mode',
    keys: ['Ctrl', 'Shift', 'Z'],
    description: 'Toggle Zen Mode',
    category: 'general',
    action: 'toggleZenMode'
  },
  {
    id: 'toggle-sidebar',
    // Ctrl+B is the tmux prefix, so it must reach the terminal
    keys: ['Ctrl', 'Shift', 'B'],
    description: 'Toggle Sidebar',
    category: 'general',
    action: 'toggleSidebar'
  },

  // Terminal
  {
    id: 'close-tab',
    keys: ['Ctrl', 'W'],
    description: 'Close Current Terminal',
    category: 'terminal',
    action: 'closeCurrentTerminal'
  },
  {
    id: 'zoom-in',
    keys: ['Ctrl', '+'],
    description: 'Zoom In Terminal',
    category: 'terminal',
    action: 'zoomIn'
  },
  {
    id: 'zoom-out',
    keys: ['Ctrl', '-'],
    description: 'Zoom Out Terminal',
    category: 'terminal',
    action: 'zoomOut'
  },
  {
    id: 'reset-zoom',
    keys: ['Ctrl', '0'],
    description: 'Reset Terminal Zoom',
    category: 'terminal',
    action: 'resetZoom'
  },
  {
    id: 'clear-terminal',
    keys: ['Ctrl', 'K'],
    description: 'Clear Terminal',
    category: 'terminal',
    action: 'clearTerminal'
  },
  {
    id: 'search-terminal',
    keys: ['Ctrl', 'F'],
    description: 'Search in Terminal',
    category: 'terminal',
    action: 'searchTerminal'
  },

  // SFTP
  {
    id: 'toggle-sftp',
    keys: ['Ctrl', 'Shift', 'S'],
    description: 'Toggle SFTP Panel',
    category: 'sftp',
    action: 'toggleSftp'
  },

  // Navigation
  {
    id: 'next-tab',
    keys: ['Ctrl', 'Tab'],
    description: 'Next Terminal Tab',
    category: 'navigation',
    action: 'nextTab'
  },
  {
    id: 'prev-tab',
    keys: ['Ctrl', 'Shift', 'Tab'],
    description: 'Previous Terminal Tab',
    category: 'navigation',
    action: 'prevTab'
  },
  {
    id: 'tab-1',
    keys: ['Ctrl', '1'],
    description: 'Jump to Terminal 1',
    category: 'navigation',
    action: 'jumpToTab1'
  },
  {
    id: 'tab-2',
    keys: ['Ctrl', '2'],
    description: 'Jump to Terminal 2',
    category: 'navigation',
    action: 'jumpToTab2'
  },
  {
    id: 'tab-3',
    keys: ['Ctrl', '3'],
    description: 'Jump to Terminal 3',
    category: 'navigation',
    action: 'jumpToTab3'
  },
  {
    id: 'tab-4',
    keys: ['Ctrl', '4'],
    description: 'Jump to Terminal 4',
    category: 'navigation',
    action: 'jumpToTab4'
  },
  {
    id: 'tab-5',
    keys: ['Ctrl', '5'],
    description: 'Jump to Terminal 5',
    category: 'navigation',
    action: 'jumpToTab5'
  },
  {
    id: 'tab-6',
    keys: ['Ctrl', '6'],
    description: 'Jump to Terminal 6',
    category: 'navigation',
    action: 'jumpToTab6'
  },
  {
    id: 'tab-7',
    keys: ['Ctrl', '7'],
    description: 'Jump to Terminal 7',
    category: 'navigation',
    action: 'jumpToTab7'
  },
  {
    id: 'tab-8',
    keys: ['Ctrl', '8'],
    description: 'Jump to Terminal 8',
    category: 'navigation',
    action: 'jumpToTab8'
  },
  {
    id: 'tab-9',
    keys: ['Ctrl', '9'],
    description: 'Jump to Terminal 9',
    category: 'navigation',
    action: 'jumpToTab9'
  }
]

export const useShortcutsStore = create<ShortcutsState>((set, get) => ({
  shortcuts: defaultShortcuts,
  customBindings: JSON.parse(localStorage.getItem('customShortcuts') || '{}'),

  getShortcut: (id: string) => {
    return get().shortcuts.find(s => s.id === id)
  },

  formatKeys: (keys: string[]) => {
    // Format keys array into readable string (e.g., ['Ctrl', 'P'] -> 'Ctrl+P')
    return keys.join('+')
  },

  getEffectiveKeys: (id: string) => {
    const { customBindings, shortcuts } = get()
    const custom = customBindings[id]
    if (custom) return custom

    const shortcut = shortcuts.find(s => s.id === id)
    return shortcut?.keys || []
  },

  setCustomBinding: (id: string, keys: string[]) => {
    const customBindings = { ...get().customBindings, [id]: keys }
    localStorage.setItem('customShortcuts', JSON.stringify(customBindings))
    set({ customBindings })
  },

  resetCustomBinding: (id: string) => {
    const customBindings = { ...get().customBindings }
    delete customBindings[id]
    localStorage.setItem('customShortcuts', JSON.stringify(customBindings))
    set({ customBindings })
  }
}))
