import { useEffect, useState, useRef } from 'react'
import { Sidebar } from './components/Sidebar/Sidebar'
import { Footer } from './components/Footer/Footer'
import { TitleBar } from './components/TitleBar/TitleBar'
import { TerminalPanel } from './components/Terminal/TerminalPanel'
import { SplitPaneTabBar } from './components/Terminal/SplitPaneTabBar'
import { TerminalWindow } from './components/Terminal/TerminalWindow'
import { SftpPanel } from './components/Sftp/SftpPanel'
import { SftpWindow } from './components/Sftp/SftpWindow'
import { ConnectModal, ConnectionConfig } from './components/Modal/ConnectModal'
import { QuickConnectModal, QuickConnectionConfig } from './components/Modal/QuickConnectModal'
import { SettingsModal } from './components/Settings/SettingsModal'
import { WelcomeScreen } from './components/MainContent/WelcomeScreen'
import { LockScreen } from './components/LockScreen/LockScreen'
import { ToastContainer } from './components/Toast'
import { toast } from './stores/toastStore'
import { UpdateNotification } from './components/Update/UpdateNotification'
import { CommandPalette } from './components/CommandPalette'
import { TabContextMenu } from './components/Terminal/TabContextMenu'
import { SnippetManager } from './components/Snippets/SnippetManager'
import { StatsDashboard } from './components/Modal/StatsDashboard'
import { BatchCommandModal } from './components/Modal/BatchCommandModal'
import { useSessionStore } from './stores/sessionStore'
import { useTerminalStore } from './stores/terminalStore'
import { useSftpStore } from './stores/sftpStore'
import { useThemeStore } from './stores/themeStore'
import { useCommandPaletteStore } from './stores/commandPaletteStore'
import { useUIStore } from './stores/uiStore'
import { useSSH } from './hooks/useSSH'
import { toSSHConnectConfig } from './lib/sshConnectConfig'
import { useKeyboardShortcuts } from './hooks/useKeyboardShortcuts'
import { motion, AnimatePresence } from 'framer-motion'
import { tabVariants } from './lib/animation/variants'
import { useReducedMotion } from './hooks/useReducedMotion'
import { SPRINGS } from './lib/animation/config'

// Check if we're in a special window mode
function getWindowModeParams() {
  const params = new URLSearchParams(window.location.search)

  // Check for SFTP mode
  if (params.get('sftpMode') === 'true') {
    return {
      mode: 'sftp' as const,
      sessionId: params.get('sessionId') || '',
      localPath: decodeURIComponent(params.get('localPath') || ''),
      remotePath: decodeURIComponent(params.get('remotePath') || '')
    }
  }

  // Check for Terminal mode
  if (params.get('terminalMode') === 'true') {
    return {
      mode: 'terminal' as const,
      sessionId: params.get('sessionId') || '',
      title: decodeURIComponent(params.get('title') || '')
    }
  }

  return null
}

function App() {
  // Check for special window modes
  const windowParams = getWindowModeParams()

  // Popped-out windows render their own toast area (copy confirmations, errors)
  if (windowParams?.mode === 'sftp') {
    return (
      <>
        <SftpWindow
          sessionId={windowParams.sessionId}
          initialLocalPath={windowParams.localPath}
          initialRemotePath={windowParams.remotePath}
        />
        <ToastContainer />
      </>
    )
  }

  if (windowParams?.mode === 'terminal') {
    return (
      <>
        <TerminalWindow
          sessionId={windowParams.sessionId}
          title={windowParams.title}
        />
        <ToastContainer />
      </>
    )
  }
  const [connectModalOpen, setConnectModalOpen] = useState(false)
  const [quickConnectModalOpen, setQuickConnectModalOpen] = useState(false)
  const [settingsModalOpen, setSettingsModalOpen] = useState(false)
  const [snippetManagerOpen, setSnippetManagerOpen] = useState(false)
  const [statsDashboardOpen, setStatsDashboardOpen] = useState(false)
  const [batchModalOpen, setBatchModalOpen] = useState(false)
  const [editSession, setEditSession] = useState<ConnectionConfig | null>(null)
  const [duplicateSource, setDuplicateSource] = useState<ConnectionConfig | null>(null)
  const [defaultFolderId, setDefaultFolderId] = useState<string | undefined>(undefined)
  const [isLocked, setIsLocked] = useState(true)
  const [hasMasterPassword, setHasMasterPassword] = useState(false)
  const [isCheckingLock, setIsCheckingLock] = useState(true)

  // Initialize theme on mount
  const initializeTheme = useThemeStore(state => state.initializeTheme)
  useEffect(() => {
    initializeTheme()
  }, [initializeTheme])

  const reducedMotion = useReducedMotion()

  // Tab drag state
  const [draggingTabId, setDraggingTabId] = useState<string | null>(null)
  const [dropZone, setDropZone] = useState<'left' | 'right' | 'top' | 'bottom' | 'popout' | null>(null)
  const terminalAreaRef = useRef<HTMLDivElement>(null)
  const [splitPaneDraggingTabId, setSplitPaneDraggingTabId] = useState<string | null>(null)

  // Context menu state
  const [contextMenuOpen, setContextMenuOpen] = useState(false)
  const [contextMenuPosition, setContextMenuPosition] = useState({ x: 0, y: 0 })
  const [contextMenuTabId, setContextMenuTabId] = useState<string | null>(null)
  const [isSettingsLoaded, setIsSettingsLoaded] = useState(false)

  // Split pane resize state
  const [splitRatio, setSplitRatio] = useState(0.5)
  const [isSplitResizing, setIsSplitResizing] = useState(false)
  const splitContainerRef = useRef<HTMLDivElement>(null)

  // Split pane session selector dropdown
  const [splitDropdownOpen, setSplitDropdownOpen] = useState<'primary' | 'secondary' | null>(null)
  const splitDropdownRef = useRef<HTMLDivElement>(null)

  const { loadFromBackend, addSession, updateSession } = useSessionStore()
  const {
    terminals,
    activeTerminalId,
    setActiveTerminal,
    removeTerminal,
    setFontSize,
    setFontFamily,
    layout,
    addTerminalToPane,
    removeTerminalFromPane,
    setActivePaneTerminal,
    setActivePaneType,
    closeSplit,
    moveTerminalBetweenPanes
  } = useTerminalStore()
  const { isOpen, setOpen } = useSftpStore()
  const { connect, disconnect } = useSSH()
  const { zenMode, toggleZenMode } = useUIStore()

  // SFTP state for active terminal
  const sftpOpen = activeTerminalId ? isOpen(activeTerminalId) : false

  // Load app settings from file
  const loadSettings = async () => {
    try {
      const settings = await window.electronAPI.loadSettings()
      if (settings.terminalFontSize) {
        setFontSize(settings.terminalFontSize)
      }
      if (settings.terminalFontFamily) {
        setFontFamily(settings.terminalFontFamily)
      }
      setIsSettingsLoaded(true)
    } catch (error) {
      console.error('Failed to load settings:', error)
      setIsSettingsLoaded(true) // Set to true even on error to prevent infinite loading
    }
  }

  // Check master password status on mount
  useEffect(() => {
    const checkLockStatus = async () => {
      try {
        const hasPwd = await window.electronAPI.hasMasterPassword()
        setHasMasterPassword(hasPwd)

        if (hasPwd) {
          const { locked } = await window.electronAPI.isAppLocked()
          setIsLocked(locked)
          if (!locked) {
            await loadSettings()
            loadFromBackend()
          } else {
            // When locked, mark settings as loaded (will load after unlock)
            setIsSettingsLoaded(true)
          }
        } else {
          // No master password set yet, show setup screen
          setIsLocked(true)
          setIsSettingsLoaded(true)
        }
      } catch (error) {
        console.error('Failed to check lock status:', error)
        setIsSettingsLoaded(true)
      } finally {
        setIsCheckingLock(false)
      }
    }

    checkLockStatus()

    // Global SSH data listener - dispatches to individual terminals
    window.electronAPI.onSshData((data: { sessionId: string; data: string }) => {
      useTerminalStore.getState().dispatchSshData(data.sessionId, data.data)
    })

    // Listen for SSH closed events
    window.electronAPI.onSshClosed((data: { sessionId: string }) => {
      // Mark as disconnected (don't remove terminal to allow reconnection)
      const { setDisconnected } = useTerminalStore.getState()
      setDisconnected(data.sessionId)
    })

    // Listen for SSH reconnection events
    window.electronAPI.onSshReconnecting((data: { sessionId: string; attempt: number; maxAttempts: number }) => {
      const { setDisconnected } = useTerminalStore.getState()
      setDisconnected(data.sessionId)
    })

    window.electronAPI.onSshReconnected((data: { sessionId: string }) => {
      const { setConnected } = useTerminalStore.getState()
      setConnected(data.sessionId)
    })

    window.electronAPI.onSshReconnectFailed((data: { sessionId: string }) => {
      const { setDisconnected } = useTerminalStore.getState()
      setDisconnected(data.sessionId)
    })

    // Listen for terminal merge events (when popped-out terminal merges back)
    window.electronAPI.onTerminalMerge((data: { sessionId: string; title: string; host: string; username: string }) => {
      const { addTerminal, setActiveTerminal } = useTerminalStore.getState()
      // The SSH connection lives in the main process, so the merged session is still connected
      addTerminal(data.sessionId, {
        id: data.sessionId,
        host: data.host,
        username: data.username,
        title: data.title,
        connected: true
      })
      setActiveTerminal(data.sessionId)
    })
  }, [])

  // Zen mode: double-ESC to exit
  const lastEscRef = useRef(0)
  useEffect(() => {
    if (!zenMode) return
    const handleEsc = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        const now = Date.now()
        if (now - lastEscRef.current < 500) {
          toggleZenMode()
          lastEscRef.current = 0
        } else {
          lastEscRef.current = now
        }
      }
    }
    window.addEventListener('keydown', handleEsc)
    return () => window.removeEventListener('keydown', handleEsc)
  }, [zenMode, toggleZenMode])

  // Close split dropdown when clicking outside
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (splitDropdownOpen && splitDropdownRef.current && !splitDropdownRef.current.contains(e.target as Node)) {
        setSplitDropdownOpen(null)
      }
    }
    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [splitDropdownOpen])

  // Split pane resize via divider drag
  useEffect(() => {
    if (!isSplitResizing) return

    const handleMouseMove = (e: MouseEvent) => {
      const container = splitContainerRef.current
      if (!container) return
      const rect = container.getBoundingClientRect()
      let ratio: number
      if (layout.direction === 'horizontal') {
        ratio = (e.clientX - rect.left) / rect.width
      } else {
        ratio = (e.clientY - rect.top) / rect.height
      }
      ratio = Math.min(0.8, Math.max(0.2, ratio))
      setSplitRatio(ratio)
    }

    const handleMouseUp = () => {
      setIsSplitResizing(false)
      document.body.classList.remove('resizing')
      window.dispatchEvent(new Event('resize'))
    }

    document.body.classList.add('resizing')
    window.addEventListener('mousemove', handleMouseMove, true)
    window.addEventListener('mouseup', handleMouseUp, true)
    return () => {
      window.removeEventListener('mousemove', handleMouseMove, true)
      window.removeEventListener('mouseup', handleMouseUp, true)
    }
  }, [isSplitResizing, layout.direction])

  // Handle terminal zoom from main process (Ctrl+/-/0 intercepted at Electron level)
  useEffect(() => {
    const cleanup = window.electronAPI.onTerminalZoom?.((direction: string) => {
      if (direction === 'in') {
        useTerminalStore.getState().increaseFontSize()
      } else if (direction === 'out') {
        useTerminalStore.getState().decreaseFontSize()
      } else if (direction === 'reset') {
        useTerminalStore.getState().resetFontSize()
      }
    })
    return () => { cleanup?.() }
  }, [])

  // Ctrl + mouse wheel → app zoom (프로그램 전체 확대/축소)
  useEffect(() => {
    const handleWheel = (e: WheelEvent) => {
      if (e.ctrlKey) {
        e.preventDefault()
        if (e.deltaY < 0) {
          window.electronAPI.appZoomIn?.()
        } else if (e.deltaY > 0) {
          window.electronAPI.appZoomOut?.()
        }
      }
    }
    window.addEventListener('wheel', handleWheel, { passive: false })
    return () => window.removeEventListener('wheel', handleWheel)
  }, [])

  const handleUnlock = async () => {
    setIsLocked(false)
    setHasMasterPassword(true)
    setIsSettingsLoaded(false) // Reset to false before loading
    await loadSettings()
    loadFromBackend()
  }

  // Keyboard shortcuts handler
  useKeyboardShortcuts({
    openCommandPalette: () => {
      useCommandPaletteStore.getState().toggle()
    },
    newConnection: () => {
      handleNewConnection()
    },
    openSettings: () => {
      handleOpenSettings()
    },
    openSnippetManager: () => {
      handleOpenSnippetManager()
    },
    toggleFullscreen: async () => {
      await window.electronAPI.toggleFullscreen()
    },
    lockApp: async () => {
      if (hasMasterPassword) {
        await window.electronAPI.lockApp()
        setIsLocked(true)
      }
    },
    closeCurrentTerminal: () => {
      if (activeTerminalId) {
        handleCloseTerminal(activeTerminalId)
      }
    },
    zoomIn: () => {
      useTerminalStore.getState().increaseFontSize()
    },
    zoomOut: () => {
      useTerminalStore.getState().decreaseFontSize()
    },
    resetZoom: () => {
      useTerminalStore.getState().resetFontSize()
    },
    clearTerminal: () => {
      window.dispatchEvent(new CustomEvent('terminal-clear'))
    },
    toggleSftp: () => {
      handleToggleSftp()
    },
    toggleZenMode: () => {
      toggleZenMode()
    },
    nextTab: () => {
      const terminalIds = Array.from(terminals.keys())
      if (terminalIds.length === 0) return
      const currentIdx = activeTerminalId ? terminalIds.indexOf(activeTerminalId) : -1
      const nextIdx = (currentIdx + 1) % terminalIds.length
      setActiveTerminal(terminalIds[nextIdx])
    },
    prevTab: () => {
      const terminalIds = Array.from(terminals.keys())
      if (terminalIds.length === 0) return
      const currentIdx = activeTerminalId ? terminalIds.indexOf(activeTerminalId) : 0
      const prevIdx = (currentIdx - 1 + terminalIds.length) % terminalIds.length
      setActiveTerminal(terminalIds[prevIdx])
    },
    jumpToTab1: () => {
      const terminalIds = Array.from(terminals.keys())
      if (terminalIds.length > 0) setActiveTerminal(terminalIds[0])
    },
    jumpToTab2: () => {
      const terminalIds = Array.from(terminals.keys())
      if (terminalIds.length > 1) setActiveTerminal(terminalIds[1])
    },
    jumpToTab3: () => {
      const terminalIds = Array.from(terminals.keys())
      if (terminalIds.length > 2) setActiveTerminal(terminalIds[2])
    },
    jumpToTab4: () => {
      const terminalIds = Array.from(terminals.keys())
      if (terminalIds.length > 3) setActiveTerminal(terminalIds[3])
    },
    jumpToTab5: () => {
      const terminalIds = Array.from(terminals.keys())
      if (terminalIds.length > 4) setActiveTerminal(terminalIds[4])
    },
    jumpToTab6: () => {
      const terminalIds = Array.from(terminals.keys())
      if (terminalIds.length > 5) setActiveTerminal(terminalIds[5])
    },
    jumpToTab7: () => {
      const terminalIds = Array.from(terminals.keys())
      if (terminalIds.length > 6) setActiveTerminal(terminalIds[6])
    },
    jumpToTab8: () => {
      const terminalIds = Array.from(terminals.keys())
      if (terminalIds.length > 7) setActiveTerminal(terminalIds[7])
    },
    jumpToTab9: () => {
      const terminalIds = Array.from(terminals.keys())
      if (terminalIds.length > 8) setActiveTerminal(terminalIds[8])
    }
  }, !isLocked)

  const handleConnect = async (config: ConnectionConfig) => {
    // Get effective color (session color or folder color chain)
    const getFolderEffectiveColor = (folderId: string): string | undefined => {
      const { folders } = useSessionStore.getState()
      const folder = folders.find(f => f.id === folderId)
      if (!folder) return undefined
      if (folder.backgroundColor) return folder.backgroundColor
      if (folder.parentId) return getFolderEffectiveColor(folder.parentId)
      return undefined
    }

    let effectiveColor = config.backgroundColor
    if (!effectiveColor && config.folderId) {
      effectiveColor = getFolderEffectiveColor(config.folderId)
    }

    // Save session first if requested (regardless of connection result)
    const savedSessionId = config.saveSession ? persistSession(config) : config.id

    // Then attempt connection
    await connect(toSSHConnectConfig({ ...config, id: savedSessionId }, effectiveColor))
    // Note: Toast notifications are handled in useSSH hook
  }

  /**
   * Add or update the sidebar session for this config and write it to disk.
   * Returns the session id; a brand-new session gets its id here so a connection
   * started right after can carry it (path bookmarks etc.).
   */
  const persistSession = (config: ConnectionConfig): string => {
    const savedSessionId = config.id ?? crypto.randomUUID()
    const sessionData = {
      name: config.name || `${config.username}@${config.host}`,
      host: config.host,
      port: config.port,
      username: config.username,
      authType: config.authType,
      password: config.password,
      privateKeyPath: config.privateKeyPath,
      passphrase: config.passphrase,
      folderId: config.folderId,
      icon: config.icon,
      tags: config.tags,
      backgroundColor: config.backgroundColor,
      connectTimeout: config.connectTimeout,
      keepaliveInterval: config.keepaliveInterval,
      autoReconnect: config.autoReconnect,
      postConnectScript: config.postConnectScript,
      useJumpHost: config.useJumpHost,
      jumpHost: config.jumpHost,
      jumpPort: config.jumpPort,
      jumpUsername: config.jumpUsername,
      jumpAuthType: config.jumpAuthType,
      jumpPassword: config.jumpPassword,
      jumpPrivateKeyPath: config.jumpPrivateKeyPath,
      jumpPassphrase: config.jumpPassphrase
    }

    if (config.id) {
      // 기존 세션 업데이트
      updateSession(config.id, sessionData)
    } else {
      // 새 세션 추가
      addSession({ ...sessionData, id: savedSessionId })
    }
    useSessionStore.getState().saveToBackend()
    return savedSessionId
  }

  // Edit/duplicate modal "저장": save the session without connecting
  const handleSaveSession = (config: ConnectionConfig) => {
    persistSession(config)
    const name = config.name || `${config.username}@${config.host}`
    toast.success('저장됨', config.id ? `${name} 세션을 수정했습니다` : `${name} 세션을 등록했습니다`)
  }

  const handleQuickConnect = async (session: any) => {
    // Get effective color (session color or folder color chain)
    const getFolderEffectiveColor = (folderId: string): string | undefined => {
      const { folders } = useSessionStore.getState()
      const folder = folders.find(f => f.id === folderId)
      if (!folder) return undefined
      if (folder.backgroundColor) return folder.backgroundColor
      if (folder.parentId) return getFolderEffectiveColor(folder.parentId)
      return undefined
    }

    let effectiveColor = session.backgroundColor
    if (!effectiveColor && session.folderId) {
      effectiveColor = getFolderEffectiveColor(session.folderId)
    }

    await handleConnect({
      ...session,
      backgroundColor: effectiveColor,
      saveSession: false
    })
  }

  const handleNewConnection = () => {
    setEditSession(null)
    setDuplicateSource(null)
    setDefaultFolderId(undefined)
    setConnectModalOpen(true)
  }

  const handleAddSession = (folderId?: string) => {
    setEditSession(null)
    setDuplicateSource(null)
    setDefaultFolderId(folderId)
    setConnectModalOpen(true)
  }

  const handleEditSession = (session: any) => {
    setDuplicateSource(null)
    setEditSession(session)
    setConnectModalOpen(true)
  }

  // Open the new-connection form prefilled from an existing session; saving creates a new session
  const handleDuplicateSession = (session: any) => {
    const baseName = session.name || `${session.username}@${session.host}`
    setEditSession(null)
    setDefaultFolderId(undefined)
    setDuplicateSource({ ...session, id: undefined, name: `${baseName} - 복제됨`, saveSession: true })
    setConnectModalOpen(true)
  }

  const handleOpenQuickConnect = () => {
    setQuickConnectModalOpen(true)
  }

  const handleQuickConnectSubmit = async (config: QuickConnectionConfig, saveSession: boolean) => {
    const fullConfig: ConnectionConfig = {
      ...config,
      name: `${config.username}@${config.host}`,
      saveSession: saveSession,
      icon: 'server'
    }
    await handleConnect(fullConfig)
  }

  const handleCloseTerminal = (sessionId: string) => {
    disconnect(sessionId)
  }

  const handleToggleSftp = () => {
    if (activeTerminalId) {
      setOpen(activeTerminalId, !sftpOpen)
    }
  }

  const terminalArray = Array.from(terminals.entries())
  const hasTerminals = terminalArray.length > 0

  // Compute active session IDs (connected terminals)
  const activeSessionIds = new Set(
    Array.from(terminals.values())
      .filter(t => t.connected)
      .map(t => t.id)
  )

  // Layout state
  const splitWithSession = useTerminalStore(state => state.splitWithSession)

  // Tab drag handlers
  const handleTabDragStart = (e: React.DragEvent, sessionId: string) => {
    setDraggingTabId(sessionId)
    e.dataTransfer.setData('text/plain', sessionId)
    e.dataTransfer.effectAllowed = 'move'
  }

  const handleTabDragEnd = async () => {
    const sessionId = draggingTabId
    const terminal = sessionId ? terminals.get(sessionId) : null

    // Check if dropped outside window (popout)
    if (dropZone === 'popout' && sessionId && terminal) {
      const title = terminal.title || `${terminal.username}@${terminal.host}`
      // Remove terminal from main window first (this unregisters the SSH data handler)
      removeTerminal(sessionId)
      // Open new window - it will register its own handler
      await window.electronAPI.openTerminalWindow(sessionId, title)
    }

    // Check if dropped in a split zone - only the dragged tab moves to the new pane
    if (sessionId && dropZone && ['left', 'right', 'top', 'bottom'].includes(dropZone)) {
      const direction = (dropZone === 'right' || dropZone === 'left') ? 'horizontal' : 'vertical'

      // Always use the dragged sessionId - it moves to the new split pane
      // Other tabs stay in the primary pane
      if (dropZone === 'right' || dropZone === 'bottom') {
        // Dragged to right/bottom: dragged tab goes to secondary pane
        splitWithSession(sessionId, direction, 'secondary')
      } else {
        // Dragged to left/top: dragged tab goes to primary pane (others move to secondary)
        splitWithSession(sessionId, direction, 'primary')
      }
    }

    setDraggingTabId(null)
    setDropZone(null)
  }

  const handleTerminalAreaDragOver = (e: React.DragEvent) => {
    if (!draggingTabId) return
    // Need at least 2 terminals to split
    if (terminalArray.length < 2) {
      setDropZone(null)
      return
    }
    e.preventDefault()

    const rect = terminalAreaRef.current?.getBoundingClientRect()
    if (!rect) return

    const x = e.clientX - rect.left
    const y = e.clientY - rect.top
    const width = rect.width
    const height = rect.height

    // Larger drop zones - 30% of each edge
    const horizontalThreshold = width * 0.3
    const verticalThreshold = height * 0.3

    if (x < horizontalThreshold) {
      setDropZone('left')
    } else if (x > width - horizontalThreshold) {
      setDropZone('right')
    } else if (y < verticalThreshold) {
      setDropZone('top')
    } else if (y > height - verticalThreshold) {
      setDropZone('bottom')
    } else {
      setDropZone(null)
    }
  }

  const handleTerminalAreaDragLeave = (e: React.DragEvent) => {
    // Check if actually leaving the terminal area (not entering a child)
    const rect = terminalAreaRef.current?.getBoundingClientRect()
    if (rect) {
      const x = e.clientX
      const y = e.clientY
      if (x < rect.left || x > rect.right || y < rect.top || y > rect.bottom) {
        setDropZone('popout')
      }
    }
  }

  const handleTerminalAreaDrop = (e: React.DragEvent) => {
    e.preventDefault()
    // Drop handling is done in handleTabDragEnd
  }

  const handleOpenSettings = () => {
    setSettingsModalOpen(true)
  }

  const handleOpenSnippetManager = () => {
    setSnippetManagerOpen(true)
  }

  // Context menu handlers
  const handleTabContextMenu = (e: React.MouseEvent, sessionId: string) => {
    e.preventDefault()
    setContextMenuPosition({ x: e.clientX, y: e.clientY })
    setContextMenuTabId(sessionId)
    setContextMenuOpen(true)
  }

  const handleCloseContextMenu = () => {
    setContextMenuOpen(false)
    setContextMenuTabId(null)
  }

  const handleContextCloseTab = () => {
    if (contextMenuTabId) {
      handleCloseTerminal(contextMenuTabId)
    }
  }

  const handleContextCloseOthers = () => {
    if (contextMenuTabId) {
      terminalArray.forEach(([sessionId]) => {
        if (sessionId !== contextMenuTabId) {
          handleCloseTerminal(sessionId)
        }
      })
    }
  }

  const handleContextCloseToRight = () => {
    if (contextMenuTabId) {
      const terminalIds = Array.from(terminals.keys())
      const currentIndex = terminalIds.indexOf(contextMenuTabId)
      if (currentIndex !== -1) {
        terminalIds.slice(currentIndex + 1).forEach(sessionId => {
          handleCloseTerminal(sessionId)
        })
      }
    }
  }

  const handleContextDuplicate = () => {
    if (contextMenuTabId) {
      const terminal = terminals.get(contextMenuTabId)
      if (terminal) {
        // Trigger new connection with same config
        handleNewConnection()
      }
    }
  }

  const handleContextRename = () => {
    if (contextMenuTabId) {
      // TODO: Implement rename functionality
      console.log('Rename tab:', contextMenuTabId)
    }
  }

  const handleContextSplitHorizontal = () => {
    if (contextMenuTabId && terminalArray.length >= 2) {
      const otherTerminals = terminalArray.filter(([id]) => id !== contextMenuTabId)
      if (otherTerminals.length > 0) {
        splitWithSession(otherTerminals[0][0], 'horizontal', 'secondary')
      }
    }
  }

  const handleContextSplitVertical = () => {
    if (contextMenuTabId && terminalArray.length >= 2) {
      const otherTerminals = terminalArray.filter(([id]) => id !== contextMenuTabId)
      if (otherTerminals.length > 0) {
        splitWithSession(otherTerminals[0][0], 'vertical', 'secondary')
      }
    }
  }

  // Show loading while checking lock status
  if (isCheckingLock) {
    return (
      <div className="app-container">
        <TitleBar onSettingsClick={handleOpenSettings} />
        <div className="app-main" style={{ alignItems: 'center', justifyContent: 'center' }}>
          <span style={{ color: 'var(--text-muted)' }}>Loading...</span>
        </div>
        <SettingsModal open={settingsModalOpen} onOpenChange={setSettingsModalOpen} />
      </div>
    )
  }

  // Show lock screen if locked
  if (isLocked) {
    return (
      <div className="app-container">
        <TitleBar onSettingsClick={handleOpenSettings} />
        <LockScreen hasMasterPassword={hasMasterPassword} onUnlock={handleUnlock} />
        <SettingsModal open={settingsModalOpen} onOpenChange={setSettingsModalOpen} />
      </div>
    )
  }

  return (
    <div className="app-container">
      <a href="#main-content" className="skip-link">Skip to main content</a>
      <TitleBar onSettingsClick={handleOpenSettings} />
      <div className={`app-main ${zenMode ? 'zen-mode' : ''}`}>
        {zenMode && (
          <div className="zen-mode-indicator">
            Zen Mode · ESC×2로 해제 · Ctrl+Shift+Z
          </div>
        )}
        <Sidebar
          onNewConnection={handleNewConnection}
          onQuickConnect={handleQuickConnect}
          onEditSession={handleEditSession}
          onDuplicateSession={handleDuplicateSession}
          onOpenQuickConnect={handleOpenQuickConnect}
          onAddSession={handleAddSession}
          onStatsClick={() => setStatsDashboardOpen(true)}
          onBatchClick={() => setBatchModalOpen(true)}
          activeSessionIds={activeSessionIds}
        />
        <main className="main-area" id="main-content">
          {!isSettingsLoaded ? (
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%' }}>
              <span style={{ color: 'var(--text-muted)' }}>Loading settings...</span>
            </div>
          ) : hasTerminals ? (
            <>
              {layout.mode !== 'split' && (
                <div className="terminal-tabs">
                  <AnimatePresence initial={false} mode="popLayout">
                    {terminalArray.map(([sessionId, terminal]) => (
                      <motion.div
                        key={sessionId}
                        className={`terminal-tab ${sessionId === activeTerminalId ? 'active' : ''} ${terminal.hasActivity ? 'has-activity' : ''} ${draggingTabId === sessionId ? 'dragging' : ''}`}
                        onClick={() => setActiveTerminal(sessionId)}
                        onContextMenu={(e) => handleTabContextMenu(e, sessionId)}
                        draggable
                        // motion.div treats onDragStart/onDragEnd as its own gesture props
                        // and never forwards them to the DOM, so use the capture variants
                        onDragStartCapture={(e) => handleTabDragStart(e, sessionId)}
                        onDragEndCapture={handleTabDragEnd}
                        variants={reducedMotion ? undefined : tabVariants}
                        initial="hidden"
                        animate="visible"
                        exit="exit"
                        layout={!reducedMotion}
                        transition={SPRINGS.snappy}
                        style={sessionId === activeTerminalId && terminal.color ? {
                          borderColor: terminal.color,
                          backgroundColor: `${terminal.color}20`,
                          color: terminal.color,
                          boxShadow: `inset 0 -2px 0 ${terminal.color}`
                        } : undefined}
                      >
                        {terminal.color && (
                          <span
                            className="tab-color-dot"
                            style={{ backgroundColor: terminal.color }}
                          />
                        )}
                        <span>{terminal.title || `${terminal.username}@${terminal.host}`}</span>
                        {terminal.hasActivity && <span className="activity-indicator" />}
                        <motion.button
                          className="tab-close"
                          onClick={(e) => { e.stopPropagation(); handleCloseTerminal(sessionId); }}
                          whileHover={reducedMotion ? undefined : { scale: 1.1 }}
                          whileTap={reducedMotion ? undefined : { scale: 0.9 }}
                        >×</motion.button>
                      </motion.div>
                    ))}
                  </AnimatePresence>
                  <motion.button
                    className="new-tab-btn"
                    onClick={handleNewConnection}
                    whileHover={reducedMotion ? undefined : { scale: 1.05 }}
                    whileTap={reducedMotion ? undefined : { scale: 0.95 }}
                  >+</motion.button>
                </div>
              )}
              <div
                ref={terminalAreaRef}
                className={`terminal-area ${draggingTabId ? 'drag-active' : ''}`}
                onDragOver={handleTerminalAreaDragOver}
                onDragLeave={handleTerminalAreaDragLeave}
                onDrop={handleTerminalAreaDrop}
              >
                {/* Drop zone indicators */}
                {draggingTabId && (
                  <>
                    <div className={`drop-zone drop-zone-left ${dropZone === 'left' ? 'active' : ''}`} />
                    <div className={`drop-zone drop-zone-right ${dropZone === 'right' ? 'active' : ''}`} />
                    <div className={`drop-zone drop-zone-top ${dropZone === 'top' ? 'active' : ''}`} />
                    <div className={`drop-zone drop-zone-bottom ${dropZone === 'bottom' ? 'active' : ''}`} />
                  </>
                )}
                {layout.mode === 'split' && layout.secondary ? (
                  <div ref={splitContainerRef} className={`split-view-container ${layout.direction} ${isSplitResizing ? 'resizing' : ''}`}>
                    {/* Primary Pane */}
                    <div
                      className={`split-pane primary ${layout.activePaneType === 'primary' ? 'active-pane' : ''}`}
                      onMouseDown={() => setActivePaneType('primary')}
                      style={{
                        flex: splitRatio,
                        ...(layout.activePaneType === 'primary' && layout.primary.activeTerminalId && terminals.get(layout.primary.activeTerminalId)?.color
                          ? { outlineColor: terminals.get(layout.primary.activeTerminalId)!.color }
                          : {})
                      }}
                    >
                      <SplitPaneTabBar
                        paneType="primary"
                        terminalIds={layout.primary.terminalIds}
                        activeTerminalId={layout.primary.activeTerminalId}
                        isActivePane={layout.activePaneType === 'primary'}
                        onTabSelect={(terminalId) => {
                          setActivePaneTerminal('primary', terminalId)
                          setActivePaneType('primary')
                        }}
                        onTabClose={(terminalId) => {
                          removeTerminalFromPane('primary', terminalId)
                          handleCloseTerminal(terminalId)
                        }}
                        onAddTab={async (session) => {
                          const result = await connect(toSSHConnectConfig(session))
                          if (result?.success && result.sessionId) {
                            addTerminalToPane('primary', result.sessionId)
                          }
                        }}
                        onUnsplit={closeSplit}
                        onSftpToggle={layout.primary.activeTerminalId ? () => {
                          const activeId = layout.primary.activeTerminalId!
                          setOpen(activeId, !isOpen(activeId))
                        } : undefined}
                        sftpOpen={layout.primary.activeTerminalId ? isOpen(layout.primary.activeTerminalId) : false}
                        onPaneFocus={() => setActivePaneType('primary')}
                        onTabDragStart={(id) => setSplitPaneDraggingTabId(id)}
                        onTabDragEnd={() => setSplitPaneDraggingTabId(null)}
                        onTabDrop={(terminalId) => {
                          moveTerminalBetweenPanes(terminalId, 'secondary', 'primary')
                          setSplitPaneDraggingTabId(null)
                        }}
                        draggingTabId={splitPaneDraggingTabId}
                      />
                      <div className="split-pane-content">
                        {layout.primary.terminalIds.map(terminalId => (
                          <div
                            key={terminalId}
                            className={`terminal-wrapper ${terminalId === layout.primary.activeTerminalId ? 'visible' : 'hidden'}`}
                          >
                            <TerminalPanel
                              sessionId={terminalId}
                              isActive={terminalId === layout.primary.activeTerminalId}
                              onActivate={() => {
                                setActivePaneTerminal('primary', terminalId)
                                setActivePaneType('primary')
                              }}
                              onClose={() => {
                                removeTerminalFromPane('primary', terminalId)
                                handleCloseTerminal(terminalId)
                              }}
                              borderColor={terminals.get(terminalId)?.color}
                            />
                          </div>
                        ))}
                        {layout.primary.activeTerminalId && isOpen(layout.primary.activeTerminalId) && (
                          <SftpPanel sessionId={layout.primary.activeTerminalId} />
                        )}
                      </div>
                    </div>
                    <div
                      className={`split-divider ${layout.direction}`}
                      onMouseDown={(e) => { e.preventDefault(); setIsSplitResizing(true) }}
                      onDoubleClick={() => closeSplit()}
                      title="드래그로 크기 조절 · 더블클릭으로 분할 해제"
                    />
                    {/* Secondary Pane */}
                    <div
                      className={`split-pane secondary ${layout.activePaneType === 'secondary' ? 'active-pane' : ''}`}
                      onMouseDown={() => setActivePaneType('secondary')}
                      style={{
                        flex: 1 - splitRatio,
                        ...(layout.activePaneType === 'secondary' && layout.secondary?.activeTerminalId && terminals.get(layout.secondary.activeTerminalId)?.color
                          ? { outlineColor: terminals.get(layout.secondary.activeTerminalId)!.color }
                          : {})
                      }}
                    >
                      <SplitPaneTabBar
                        paneType="secondary"
                        terminalIds={layout.secondary.terminalIds}
                        activeTerminalId={layout.secondary.activeTerminalId}
                        isActivePane={layout.activePaneType === 'secondary'}
                        onTabSelect={(terminalId) => {
                          setActivePaneTerminal('secondary', terminalId)
                          setActivePaneType('secondary')
                        }}
                        onTabClose={(terminalId) => {
                          removeTerminalFromPane('secondary', terminalId)
                          handleCloseTerminal(terminalId)
                        }}
                        onAddTab={async (session) => {
                          const result = await connect(toSSHConnectConfig(session))
                          if (result?.success && result.sessionId) {
                            addTerminalToPane('secondary', result.sessionId)
                          }
                        }}
                        onSftpToggle={layout.secondary.activeTerminalId ? () => {
                          const activeId = layout.secondary!.activeTerminalId!
                          setOpen(activeId, !isOpen(activeId))
                        } : undefined}
                        sftpOpen={layout.secondary.activeTerminalId ? isOpen(layout.secondary.activeTerminalId) : false}
                        onPaneFocus={() => setActivePaneType('secondary')}
                        onTabDragStart={(id) => setSplitPaneDraggingTabId(id)}
                        onTabDragEnd={() => setSplitPaneDraggingTabId(null)}
                        onTabDrop={(terminalId) => {
                          moveTerminalBetweenPanes(terminalId, 'primary', 'secondary')
                          setSplitPaneDraggingTabId(null)
                        }}
                        draggingTabId={splitPaneDraggingTabId}
                      />
                      <div className="split-pane-content">
                        {layout.secondary.terminalIds.map(terminalId => (
                          <div
                            key={terminalId}
                            className={`terminal-wrapper ${terminalId === layout.secondary!.activeTerminalId ? 'visible' : 'hidden'}`}
                          >
                            <TerminalPanel
                              sessionId={terminalId}
                              isActive={terminalId === layout.secondary!.activeTerminalId}
                              onActivate={() => {
                                setActivePaneTerminal('secondary', terminalId)
                                setActivePaneType('secondary')
                              }}
                              onClose={() => {
                                removeTerminalFromPane('secondary', terminalId)
                                handleCloseTerminal(terminalId)
                              }}
                              borderColor={terminals.get(terminalId)?.color}
                            />
                          </div>
                        ))}
                        {layout.secondary.activeTerminalId && isOpen(layout.secondary.activeTerminalId) && (
                          <SftpPanel sessionId={layout.secondary.activeTerminalId} />
                        )}
                      </div>
                    </div>
                  </div>
                ) : (
                  terminalArray.map(([sessionId, terminal]) => (
                    <div
                      key={sessionId}
                      className={`terminal-wrapper ${sessionId === activeTerminalId ? 'visible' : 'hidden'}`}
                    >
                      <TerminalPanel
                        sessionId={sessionId}
                        isActive={sessionId === activeTerminalId}
                        onActivate={() => setActiveTerminal(sessionId)}
                        onClose={() => handleCloseTerminal(sessionId)}
                        borderColor={terminal.color}
                      />
                    </div>
                  ))
                )}
              </div>
              {/* Hidden while the panel is open (it has its own close button) so the panel gets the space */}
              {activeTerminalId && layout.mode !== 'split' && !sftpOpen && (
                <div className="toolbar">
                  <button
                    className="toolbar-btn"
                    onClick={handleToggleSftp}
                  >
                    SFTP
                  </button>
                </div>
              )}
              {sftpOpen && activeTerminalId && layout.mode !== 'split' && (
                <SftpPanel sessionId={activeTerminalId} />
              )}
            </>
          ) : (
            <WelcomeScreen onNewConnection={handleNewConnection} />
          )}
        </main>
      </div>
      <Footer />

      <ConnectModal
        open={connectModalOpen}
        onOpenChange={setConnectModalOpen}
        onConnect={handleConnect}
        onSave={handleSaveSession}
        editSession={editSession}
        duplicateFrom={duplicateSource}
        defaultFolderId={defaultFolderId}
      />

      <QuickConnectModal
        open={quickConnectModalOpen}
        onOpenChange={setQuickConnectModalOpen}
        onConnect={handleQuickConnectSubmit}
      />

      <SettingsModal
        open={settingsModalOpen}
        onOpenChange={setSettingsModalOpen}
      />

      <CommandPalette
        onNewConnection={handleNewConnection}
        onQuickConnect={handleQuickConnect}
        onOpenSettings={handleOpenSettings}
        onOpenSnippetManager={handleOpenSnippetManager}
      />

      {snippetManagerOpen && (
        <SnippetManager onClose={() => setSnippetManagerOpen(false)} />
      )}

      <StatsDashboard open={statsDashboardOpen} onClose={() => setStatsDashboardOpen(false)} />

      <BatchCommandModal open={batchModalOpen} onClose={() => setBatchModalOpen(false)} />

      <TabContextMenu
        isOpen={contextMenuOpen}
        position={contextMenuPosition}
        tabId={contextMenuTabId || ''}
        onClose={handleCloseContextMenu}
        onCloseTab={handleContextCloseTab}
        onCloseOthers={handleContextCloseOthers}
        onCloseToRight={handleContextCloseToRight}
        onDuplicate={handleContextDuplicate}
        onRename={handleContextRename}
        onSplitHorizontal={handleContextSplitHorizontal}
        onSplitVertical={handleContextSplitVertical}
      />

      <ToastContainer />
      <UpdateNotification />
    </div>
  )
}

export default App
