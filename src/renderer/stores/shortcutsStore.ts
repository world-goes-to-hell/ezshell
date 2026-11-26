import { create } from 'zustand'
import { parseCustomBindings } from '../lib/shortcutCapture'
import { shortcutLabel } from '../lib/shortcutModifiers'

export type ShortcutCategory = 'general' | 'terminal' | 'sftp' | 'navigation'

export interface Shortcut {
  id: string
  keys: string[] // e.g., ['Ctrl', 'P']
  description: string
  category: ShortcutCategory
  action: string // action identifier
  fixed?: boolean
  /** A line under the name in settings: where or how the shortcut works */
  note?: string
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

const NO_SHORTCUT_KEYS: string[] = []

// Default shortcuts configuration
const defaultShortcuts: Shortcut[] = [
  // General
  ...(typeof navigator !== 'undefined' && /^Win/i.test(navigator.platform) ? [{
    id: 'quick-capture',
    keys: ['Ctrl', 'Alt', 'Shift'],
    description: '영역 캡처',
    category: 'general' as const,
    action: 'quickCapture'
  }, {
    id: 'quick-capture-win',
    keys: ['Ctrl', 'Win', 'Alt'],
    description: '영역 캡처',
    category: 'general' as const,
    action: 'quickCapture'
  }] : []),
  {
    id: 'command-palette',
    keys: ['Ctrl', 'P'],
    description: '명령 팔레트 열기',
    category: 'general',
    action: 'openCommandPalette'
  },
  {
    id: 'new-connection',
    keys: ['Ctrl', 'N'],
    description: '새 연결',
    category: 'general',
    action: 'newConnection'
  },
  {
    id: 'settings',
    keys: ['Ctrl', ','],
    description: '설정 열기',
    category: 'general',
    action: 'openSettings'
  },
  {
    id: 'snippet-manager',
    keys: ['Ctrl', 'Shift', 'P'],
    description: '스니펫 관리 열기',
    category: 'general',
    action: 'openSnippetManager'
  },
  {
    id: 'fullscreen',
    keys: ['F11'],
    description: '전체 화면 켜고 끄기',
    category: 'general',
    action: 'toggleFullscreen'
  },
  {
    id: 'lock-app',
    keys: ['Ctrl', 'L'],
    description: '앱 잠금',
    category: 'general',
    action: 'lockApp'
  },
  {
    id: 'zen-mode',
    keys: ['Ctrl', 'Shift', 'Z'],
    description: '집중 모드 켜고 끄기',
    category: 'general',
    action: 'toggleZenMode'
  },
  {
    id: 'toggle-sidebar',
    // Ctrl+B is the tmux prefix, so it must reach the terminal
    keys: ['Ctrl', 'Shift', 'B'],
    description: '사이드바 접기·펼치기',
    category: 'general',
    action: 'toggleSidebar'
  },

  // Terminal
  {
    id: 'close-tab',
    keys: ['Ctrl', 'W'],
    description: '현재 탭 닫기',
    category: 'terminal',
    action: 'closeCurrentTerminal'
  },
  {
    id: 'zoom-in',
    keys: ['Ctrl', '+'],
    description: '터미널 글자 크게',
    category: 'terminal',
    action: 'zoomIn'
  },
  {
    id: 'zoom-out',
    keys: ['Ctrl', '-'],
    description: '터미널 글자 작게',
    category: 'terminal',
    action: 'zoomOut'
  },
  {
    id: 'reset-zoom',
    keys: ['Ctrl', '0'],
    description: '터미널 글자 크기 되돌리기',
    category: 'terminal',
    action: 'resetZoom'
  },
  {
    id: 'clear-terminal',
    keys: ['Ctrl', 'K'],
    description: '터미널 화면 지우기',
    category: 'terminal',
    action: 'clearTerminal'
  },
  {
    id: 'search-terminal',
    keys: ['Ctrl', 'F'],
    description: '터미널에서 찾기',
    category: 'terminal',
    action: 'searchTerminal'
  },
  // Taken by the pane itself (the key is pressed in a terminal or the chat's text box): AgentChat
  {
    id: 'toggle-agent-chat',
    keys: ['Ctrl', 'Shift', 'F11'],
    description: '에이전트 칸을 채팅 보기 ↔ 터미널로 바꾸기',
    category: 'terminal',
    action: 'toggleAgentChat'
  },

  // SFTP
  {
    id: 'toggle-sftp',
    keys: ['Ctrl', 'Shift', 'S'],
    description: 'SFTP 패널 열고 닫기',
    category: 'sftp',
    action: 'toggleSftp'
  },

  // Navigation
  // The work overview (Sidebar/WorkOverview.tsx): also in a terminal and, on Windows, from any program
  // (src/globalDoubleTab.js). Tab Tab until 2026-11-24: it fired on a shell's Tab Tab completion.
  {
    id: 'work-overview',
    keys: ['Ctrl', 'Alt', 'Space'],
    description: '로컬 작업 현황 열기',
    category: 'navigation',
    action: 'openWorkOverview',
    note: typeof navigator !== 'undefined' && /^Win/i.test(navigator.platform) ? '다른 프로그램과 터미널에서도 동작 · 수정키 두 개 이상' : '터미널에서도 동작 · 수정키 두 개 이상'
  },
  // 프로젝트 검색 (components/ProjectSearch): heard everywhere in the window, a terminal included
  {
    id: 'project-file-search',
    keys: ['Shift', 'Shift'],
    description: '프로젝트 파일 찾기',
    category: 'navigation',
    action: 'openProjectFileSearch',
    fixed: true,
    note: 'Shift 를 빠르게 두 번 · 터미널에서도 동작'
  },
  {
    id: 'project-content-search',
    keys: ['Ctrl', 'Shift', 'F'],
    description: '프로젝트 내용 검색',
    category: 'navigation',
    action: 'openProjectContentSearch',
    note: '터미널에서도 동작'
  },
  {
    id: 'next-tab',
    keys: ['Ctrl', 'Tab'],
    description: '다음 탭',
    category: 'navigation',
    action: 'nextTab'
  },
  {
    id: 'prev-tab',
    keys: ['Ctrl', 'Shift', 'Tab'],
    description: '이전 탭',
    category: 'navigation',
    action: 'prevTab'
  },
  {
    id: 'tab-1',
    keys: ['Ctrl', '1'],
    description: '1번 탭으로 이동',
    category: 'navigation',
    action: 'jumpToTab1'
  },
  {
    id: 'tab-2',
    keys: ['Ctrl', '2'],
    description: '2번 탭으로 이동',
    category: 'navigation',
    action: 'jumpToTab2'
  },
  {
    id: 'tab-3',
    keys: ['Ctrl', '3'],
    description: '3번 탭으로 이동',
    category: 'navigation',
    action: 'jumpToTab3'
  },
  {
    id: 'tab-4',
    keys: ['Ctrl', '4'],
    description: '4번 탭으로 이동',
    category: 'navigation',
    action: 'jumpToTab4'
  },
  {
    id: 'tab-5',
    keys: ['Ctrl', '5'],
    description: '5번 탭으로 이동',
    category: 'navigation',
    action: 'jumpToTab5'
  },
  {
    id: 'tab-6',
    keys: ['Ctrl', '6'],
    description: '6번 탭으로 이동',
    category: 'navigation',
    action: 'jumpToTab6'
  },
  {
    id: 'tab-7',
    keys: ['Ctrl', '7'],
    description: '7번 탭으로 이동',
    category: 'navigation',
    action: 'jumpToTab7'
  },
  {
    id: 'tab-8',
    keys: ['Ctrl', '8'],
    description: '8번 탭으로 이동',
    category: 'navigation',
    action: 'jumpToTab8'
  },
  {
    id: 'tab-9',
    keys: ['Ctrl', '9'],
    description: '9번 탭으로 이동',
    category: 'navigation',
    action: 'jumpToTab9'
  }
]

function readSavedBindings(): string | null {
  try {
    return localStorage.getItem('customShortcuts')
  } catch {
    return null
  }
}

export const useShortcutsStore = create<ShortcutsState>((set, get) => ({
  shortcuts: defaultShortcuts,
  // Saved bindings are checked before use: a damaged value must not stop the app from starting
  customBindings: parseCustomBindings(readSavedBindings(), defaultShortcuts.filter(shortcut => !shortcut.fixed).map(shortcut => shortcut.id)),

  getShortcut: (id: string) => {
    return get().shortcuts.find(s => s.id === id)
  },

  formatKeys: (keys: string[]) => {
    // ['Ctrl', 'P'] -> 'Ctrl+P', and '⌘ P' on macOS where the main modifier is the Command key
    return shortcutLabel(keys)
  },

  getEffectiveKeys: (id: string) => {
    const { customBindings, shortcuts } = get()
    const custom = customBindings[id]
    if (custom) return custom

    const shortcut = shortcuts.find(s => s.id === id)
    return shortcut?.keys ?? NO_SHORTCUT_KEYS
  },

  setCustomBinding: (id: string, keys: string[]) => {
    if (get().getShortcut(id)?.fixed) return
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
