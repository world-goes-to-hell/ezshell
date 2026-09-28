import { useEffect, useRef, useMemo, useCallback } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import Fuse from 'fuse.js'
import { RiSearchLine, RiServerLine, RiSettings3Line, RiCommandLine, RiTimeLine, RiHistoryLine, RiDeleteBinLine, RiFileTextLine } from 'react-icons/ri'
import { useCommandPaletteStore, CommandItem } from '../../stores/commandPaletteStore'
import { useSessionStore } from '../../stores/sessionStore'
import { useHistoryStore } from '../../stores/historyStore'
import { useThemeStore } from '../../stores/themeStore'
import { useSnippetStore } from '../../stores/snippetStore'
import { useTerminalStore } from '../../stores/terminalStore'
import { useReducedMotion } from '../../hooks/useReducedMotion'
import { modalOverlayVariants } from '../../lib/animation/variants'
import { formatRelativeTime } from '../../utils/timeFormat'
import './CommandPalette.css'

interface CommandPaletteProps {
  onNewConnection: () => void
  onQuickConnect: (session: any) => void
  onOpenSettings: () => void
  onOpenSnippetManager?: () => void
}

const categoryIcons = {
  connection: RiServerLine,
  command: RiCommandLine,
  settings: RiSettings3Line,
  recent: RiTimeLine,
  history: RiHistoryLine,
  snippet: RiFileTextLine,
}

export function CommandPalette({ onNewConnection, onQuickConnect, onOpenSettings, onOpenSnippetManager }: CommandPaletteProps) {
  const { isOpen, query, selectedIndex, recentCommands, close, setQuery, setSelectedIndex, addRecentCommand } = useCommandPaletteStore()
  const { sessions, activeSessionId } = useSessionStore()
  const { recentConnections, clearHistory } = useHistoryStore()
  const { currentThemeId, setTheme, getAllThemes } = useThemeStore()
  const themes = getAllThemes()
  const { snippets, expandVariables } = useSnippetStore()
  const { getTerminal } = useTerminalStore()
  const reducedMotion = useReducedMotion()
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)

  // Build command items
  const commands = useMemo((): CommandItem[] => {
    const items: CommandItem[] = []

    // Add recent connection history at the top
    recentConnections.forEach(record => {
      const session = sessions.find(s => s.id === record.sessionId)
      if (session) {
        items.push({
          id: `history-${record.id}`,
          title: record.sessionName,
          subtitle: `${record.username}@${record.host} · ${formatRelativeTime(record.connectedAt)}`,
          category: 'history',
          action: () => onQuickConnect(session),
          keywords: [record.host, record.username, record.sessionName, 'history', '기록'],
        })
      }
    })

    // Add connection commands
    sessions.forEach(session => {
      items.push({
        id: `connect-${session.id}`,
        title: session.name || `${session.username}@${session.host}`,
        subtitle: `${session.username}@${session.host}:${session.port}`,
        category: 'connection',
        action: () => onQuickConnect(session),
        keywords: [session.host, session.username, session.name || ''],
      })
    })

    // Add general commands
    items.push({
      id: 'new-connection',
      title: '새 연결',
      subtitle: '새 SSH 연결 생성',
      category: 'command',
      shortcut: 'Ctrl+N',
      action: onNewConnection,
      keywords: ['new', 'connection', 'ssh', '연결'],
    })

    items.push({
      id: 'open-settings',
      title: '설정 열기',
      subtitle: '앱 설정 및 테마 변경',
      category: 'settings',
      shortcut: 'Ctrl+,',
      action: onOpenSettings,
      keywords: ['settings', 'preferences', '설정'],
    })

    // Add snippet manager command
    if (onOpenSnippetManager) {
      items.push({
        id: 'manage-snippets',
        title: 'Manage Snippets',
        subtitle: 'Open snippet manager',
        category: 'command',
        shortcut: 'Ctrl+Shift+S',
        action: onOpenSnippetManager,
        keywords: ['snippet', 'snippets', 'manage', 'command'],
      })
    }

    // Add snippet commands
    snippets.forEach(snippet => {
      items.push({
        id: `snippet-${snippet.id}`,
        title: `Snippet: ${snippet.name}`,
        subtitle: snippet.description || snippet.command,
        category: 'snippet',
        action: () => {
          if (activeSessionId) {
            const terminal = getTerminal(activeSessionId)
            const context: Record<string, string> = terminal ? {
              user: terminal.username,
              host: terminal.host,
              path: terminal.currentPath || '~'
            } : {}
            const expandedCommand = expandVariables(snippet.command, context)
            window.electronAPI.sshSend(activeSessionId, expandedCommand + '\n')
          }
        },
        keywords: [snippet.name, snippet.command, snippet.category || '', snippet.description || ''],
      })
    })

    // Add clear history command if there are recent connections
    if (recentConnections.length > 0) {
      items.push({
        id: 'clear-history',
        title: '연결 기록 삭제',
        subtitle: '모든 연결 기록 삭제',
        category: 'command',
        icon: 'delete',
        action: () => {
          clearHistory()
          close()
        },
        keywords: ['clear', 'history', '기록', '삭제'],
      })
    }

    // Add theme commands
    themes.forEach(t => {
      items.push({
        id: `theme-${t.id}`,
        title: `테마: ${t.name}`,
        subtitle: currentThemeId === t.id ? '현재 테마' : '테마 변경',
        category: 'settings',
        action: () => setTheme(t.id),
        keywords: ['theme', '테마', t.name],
      })
    })

    return items
  }, [sessions, recentConnections, themes, currentThemeId, snippets, activeSessionId, onNewConnection, onQuickConnect, onOpenSettings, onOpenSnippetManager, setTheme, clearHistory, close, expandVariables, getTerminal])

  // Fuse.js search
  const fuse = useMemo(() => {
    return new Fuse(commands, {
      keys: ['title', 'subtitle', 'keywords'],
      threshold: 0.4,
      includeScore: true,
    })
  }, [commands])

  // Filter and sort results
  const filteredCommands = useMemo(() => {
    if (!query.trim()) {
      // Show recent commands first, then all
      const recent = recentCommands
        .map(id => commands.find(c => c.id === id))
        .filter(Boolean) as CommandItem[]
      const others = commands.filter(c => !recentCommands.includes(c.id))
      return [...recent.map(c => ({ ...c, category: 'recent' as const })), ...others]
    }
    return fuse.search(query).map(result => result.item)
  }, [query, commands, fuse, recentCommands])

  // Keyboard navigation
  useEffect(() => {
    if (!isOpen) return

    const handleKeyDown = (e: KeyboardEvent) => {
      switch (e.key) {
        case 'ArrowDown':
          e.preventDefault()
          setSelectedIndex(Math.min(selectedIndex + 1, filteredCommands.length - 1))
          break
        case 'ArrowUp':
          e.preventDefault()
          setSelectedIndex(Math.max(selectedIndex - 1, 0))
          break
        case 'Enter':
          e.preventDefault()
          if (filteredCommands[selectedIndex]) {
            executeCommand(filteredCommands[selectedIndex])
          }
          break
        case 'Escape':
          e.preventDefault()
          close()
          break
      }
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [isOpen, selectedIndex, filteredCommands, close, setSelectedIndex])

  // Focus input when opened
  useEffect(() => {
    if (isOpen && inputRef.current) {
      inputRef.current.focus()
    }
  }, [isOpen])

  // Scroll selected item into view
  useEffect(() => {
    if (listRef.current) {
      const selectedEl = listRef.current.querySelector('.command-item.selected')
      if (selectedEl) {
        selectedEl.scrollIntoView({ block: 'nearest' })
      }
    }
  }, [selectedIndex])

  // Global keyboard shortcut
  useEffect(() => {
    const handleGlobalKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'p') {
        e.preventDefault()
        useCommandPaletteStore.getState().toggle()
      }
    }

    window.addEventListener('keydown', handleGlobalKeyDown)
    return () => window.removeEventListener('keydown', handleGlobalKeyDown)
  }, [])

  const executeCommand = useCallback((command: CommandItem) => {
    addRecentCommand(command.id)
    command.action()
    close()
  }, [addRecentCommand, close])

  const getCategoryIcon = (category: CommandItem['category'], iconOverride?: string) => {
    if (iconOverride === 'delete') {
      return <RiDeleteBinLine size={16} />
    }
    const Icon = categoryIcons[category]
    return <Icon size={16} />
  }

  return (
    <AnimatePresence>
      {isOpen && (
        <>
          <motion.div
            className="command-palette-overlay"
            variants={modalOverlayVariants}
            initial="hidden"
            animate="visible"
            exit="exit"
            onClick={close}
          />
          <motion.div
            className="command-palette"
            role="dialog"
            aria-label="Command palette"
            initial={reducedMotion ? { opacity: 0 } : { opacity: 0, scale: 0.95, y: -20 }}
            animate={reducedMotion ? { opacity: 1 } : { opacity: 1, scale: 1, y: 0 }}
            exit={reducedMotion ? { opacity: 0 } : { opacity: 0, scale: 0.95, y: -20 }}
            transition={{ duration: 0.15 }}
          >
            <div className="command-palette-input-wrapper">
              <RiSearchLine size={20} className="command-palette-search-icon" />
              <input
                ref={inputRef}
                type="text"
                className="command-palette-input"
                placeholder="명령어, 연결, 설정 검색..."
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                role="combobox"
                aria-expanded={filteredCommands.length > 0}
                aria-controls="command-list"
                aria-activedescendant={selectedIndex >= 0 ? `command-item-${selectedIndex}` : undefined}
                aria-autocomplete="list"
              />
              <kbd className="command-palette-shortcut">ESC</kbd>
            </div>
            <div
              className="command-palette-list"
              ref={listRef}
              role="listbox"
              id="command-list"
            >
              {filteredCommands.length === 0 ? (
                <div className="command-palette-empty">
                  검색 결과가 없습니다
                </div>
              ) : (
                filteredCommands.map((command, index) => (
                  <div
                    key={command.id}
                    id={`command-item-${index}`}
                    className={`command-item ${index === selectedIndex ? 'selected' : ''}`}
                    role="option"
                    aria-selected={index === selectedIndex}
                    onClick={() => executeCommand(command)}
                    onMouseEnter={() => setSelectedIndex(index)}
                  >
                    <div className="command-item-icon">
                      {getCategoryIcon(command.category, command.icon)}
                    </div>
                    <div className="command-item-content">
                      <div className="command-item-title">{command.title}</div>
                      {command.subtitle && (
                        <div className="command-item-subtitle">{command.subtitle}</div>
                      )}
                    </div>
                    {command.shortcut && (
                      <kbd className="command-item-shortcut">{command.shortcut}</kbd>
                    )}
                  </div>
                ))
              )}
            </div>
            <div className="command-palette-footer">
              <span><kbd>↑↓</kbd> 탐색</span>
              <span><kbd>Enter</kbd> 실행</span>
              <span><kbd>Esc</kbd> 닫기</span>
            </div>
          </motion.div>
        </>
      )}
    </AnimatePresence>
  )
}
