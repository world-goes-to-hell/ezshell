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
import { useSessionLogStore } from '../../stores/sessionLogStore'
import { useWorkspacePanelStore } from '../../stores/workspacePanelStore'
import { useByteDaemonStore } from '../../stores/byteDaemonStore'
import { openSessionLogFolder, toggleSessionLog } from '../../lib/sessionLogActions'
import { useReducedMotion } from '../../hooks/useReducedMotion'
import { modalOverlayVariants } from '../../lib/animation/variants'
import { formatRelativeTime } from '../../utils/timeFormat'
import { getFolderPath } from '../../lib/sessionPicker'
import { isSshTab } from '../../lib/sessionTabs'
import { openAgentMessages } from '../Terminal/AgentMessages'
import { copyDiagnostics, hasDiagnostics } from '../../lib/diagnostics'
import './CommandPalette.css'

interface CommandPaletteProps {
  onNewConnection: () => void
  onQuickConnect: (session: any) => void
  onOpenSettings: () => void
  onOpenSnippetManager?: () => void
  onOpenWhatsNew?: () => void
  onOpenBatch?: () => void
  onOpenStats?: () => void
  onOpenLocalProject?: () => void
}

const categoryIcons = {
  connection: RiServerLine,
  command: RiCommandLine,
  settings: RiSettings3Line,
  recent: RiTimeLine,
  history: RiHistoryLine,
  snippet: RiFileTextLine,
}

export function CommandPalette({ onNewConnection, onQuickConnect, onOpenSettings, onOpenSnippetManager, onOpenWhatsNew, onOpenBatch, onOpenStats, onOpenLocalProject }: CommandPaletteProps) {
  const { isOpen, query, selectedIndex, recentCommands, close, setQuery, setSelectedIndex, addRecentCommand } = useCommandPaletteStore()
  const { sessions, folders, activeSessionId } = useSessionStore()
  const { recentConnections, clearHistory } = useHistoryStore()
  const { currentThemeId, setTheme, getAllThemes } = useThemeStore()
  const themes = getAllThemes()
  const { snippets, expandVariables } = useSnippetStore()
  const { getTerminal } = useTerminalStore()
  const activeTerminalId = useTerminalStore(state => state.activeTerminalId)
  const sessionLogFiles = useSessionLogStore(state => state.files)
  const byteDaemonHidden = useByteDaemonStore(state => state.save.hidden)
  const setByteDaemonHidden = useByteDaemonStore(state => state.setHidden)
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
        const folderPath = getFolderPath(session.folderId, folders)
        items.push({
          id: `history-${record.id}`,
          title: record.sessionName,
          subtitle: [`${record.username}@${record.host}`, folderPath, formatRelativeTime(record.connectedAt)].filter(Boolean).join(' · '),
          category: 'history',
          action: () => onQuickConnect(session),
          keywords: [record.host, record.username, record.sessionName, folderPath, 'history', '기록'],
        })
      }
    })

    // Add connection commands
    sessions.forEach(session => {
      const folderPath = getFolderPath(session.folderId, folders)
      items.push({
        id: `connect-${session.id}`,
        title: session.name || `${session.username}@${session.host}`,
        subtitle: [`${session.username}@${session.host}:${session.port}`, folderPath].filter(Boolean).join(' · '),
        category: 'connection',
        action: () => onQuickConnect(session),
        keywords: [session.host, session.username, session.name || '', folderPath],
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

    if (/^Win/i.test(navigator.platform) && window.electronAPI.startQuickCapture) {
      items.push({
        id: 'quick-capture',
        title: '영역 캡처',
        category: 'command',
        action: () => window.setTimeout(() => window.electronAPI.startQuickCapture?.(), 200),
        keywords: ['capture', 'screenshot', '화면', '스크린샷'],
      })
    }

    // Opened from here only (the sidebar's bottom buttons were taken out)
    items.push({
      id: 'agent-messages',
      title: '에이전트 메시지 열기',
      subtitle: '로컬 터미널의 Claude Code·Codex 가 주고받은 메시지함',
      category: 'command',
      action: () => openAgentMessages(),
      keywords: ['agent', 'message', 'inbox', 'mail', 'claude', 'codex', '에이전트', '메시지', '메시지함', '편지'],
    })
    if (onOpenLocalProject) {
      items.push({
        id: 'local-project',
        title: '로컬 작업 열기',
        subtitle: '작업 폴더·워크트리를 골라 로컬 터미널이나 에이전트로 열기',
        category: 'command',
        action: onOpenLocalProject,
        keywords: ['local', 'project', 'worktree', 'folder', '로컬', '작업', '폴더', '워크트리'],
      })
    }
    if (onOpenBatch) {
      items.push({
        id: 'batch-command',
        title: '배치 명령 실행',
        subtitle: '여러 SSH 탭에 같은 명령을 한 번에 보내기',
        category: 'command',
        action: onOpenBatch,
        keywords: ['batch', 'broadcast', 'command', 'multi', '배치', '일괄', '명령', '여러'],
      })
    }
    if (onOpenStats) {
      items.push({
        id: 'session-stats',
        title: '세션 통계',
        subtitle: '세션별 접속 횟수와 사용 시간',
        category: 'command',
        action: onOpenStats,
        keywords: ['stats', 'statistics', 'usage', 'dashboard', '통계', '사용량', '접속'],
      })
    }

    // For bug reports (docs/plan/2026-11-28-diagnostics.md): versions, agent states and recent errors, no messages
    if (hasDiagnostics()) {
      items.push({
        id: 'diagnostics-copy',
        title: '진단 정보 복사',
        subtitle: '버그를 알릴 때 붙일 버전·에이전트 상태·최근 오류 (메시지·비밀 값 없음)',
        category: 'command',
        action: () => void copyDiagnostics(),
        keywords: ['diagnostics', 'bug', 'report', 'error', 'log', 'version', '진단', '버그', '오류', '로그', '버전', '신고'],
      })
    }

    if (typeof window.electronAPI?.agentHistoryList === 'function') {
      items.push({
        id: 'workspace-panel',
        title: '작업 공간 열기',
        subtitle: '로컬 셸 작업용 패널: 이 PC 에서 실행한 Claude Code·Codex 대화를 찾고 이어서 실행',
        category: 'command',
        action: () => useWorkspacePanelStore.getState().open('history'),
        keywords: ['workspace', 'agent', 'history', 'session', 'resume', 'claude', 'codex', '작업 공간', '에이전트', '대화', '기록', '이어서'],
      })
    }

    // The Byte Daemon mini game hides at the end of the status bar; this is how to hide or bring it back
    items.push({
      id: 'byte-daemon-toggle',
      title: byteDaemonHidden ? '미니 게임 아이콘 보이기' : '미니 게임 아이콘 숨기기',
      subtitle: byteDaemonHidden ? '상태 줄 끝에 바이트 데몬을 다시 둡니다' : '상태 줄 끝의 바이트 데몬을 감춥니다 (진행 상황은 남음)',
      category: 'command',
      action: () => setByteDaemonHidden(!byteDaemonHidden),
      keywords: ['byte', 'daemon', 'game', 'mini', 'idle', '미니 게임', '게임', '바이트', '데몬', '숨기기', '보이기'],
    })

    if (onOpenWhatsNew) {
      items.push({
        id: 'whats-new',
        title: '업데이트 내용 보기',
        subtitle: '이 버전에서 바뀐 내용',
        category: 'command',
        action: onOpenWhatsNew,
        keywords: ['update', 'release', 'notes', 'changelog', '업데이트', '변경', '새 기능'],
      })
    }

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

    // Session log of the active tab (the only way to reach it in split layout, where tabs have no context menu)
    const activeTab = activeTerminalId ? getTerminal(activeTerminalId) : undefined
    if (activeTerminalId && activeTab && isSshTab(activeTab)) {
      const isLogging = activeTerminalId in sessionLogFiles
      const tabName = activeTab.title || `${activeTab.username}@${activeTab.host}`
      items.push({
        id: 'toggle-session-log',
        title: isLogging ? '로그 저장 중지' : '로그 저장 시작',
        subtitle: isLogging ? sessionLogFiles[activeTerminalId] : `${tabName} 탭의 터미널 출력을 파일로 저장`,
        category: 'command',
        action: () => { toggleSessionLog(activeTerminalId, tabName) },
        keywords: ['log', 'logging', '로그', '기록', '저장'],
      })
    }
    items.push({
      id: 'open-session-log-folder',
      title: '로그 폴더 열기',
      subtitle: '저장된 세션 로그 파일이 있는 폴더',
      category: 'command',
      action: () => { openSessionLogFolder() },
      keywords: ['log', 'folder', '로그', '폴더'],
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
  }, [sessions, folders, recentConnections, themes, currentThemeId, snippets, activeSessionId, activeTerminalId, sessionLogFiles, onNewConnection, onQuickConnect, onOpenSettings, onOpenSnippetManager, onOpenWhatsNew, onOpenBatch, onOpenStats, onOpenLocalProject, setTheme, clearHistory, close, expandVariables, getTerminal, byteDaemonHidden, setByteDaemonHidden])

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
      if (e.isComposing) return
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

  // Opening and closing by shortcut is done by the app's shortcut handler (App.tsx, openCommandPalette),
  // which follows the binding the user set in settings. A handler here used to listen for Ctrl+P by
  // itself, so the old key kept working after the shortcut was changed.

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
