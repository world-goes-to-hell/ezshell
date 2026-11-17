import { droppedFilePaths, dropUploadStatus } from '../../lib/droppedFiles'
import { useEffect, useMemo, useRef, useState, useCallback } from 'react'
import { throttle, REFIT_INTERVAL_MS, type Throttled } from '../../lib/throttle'
import { Terminal } from 'xterm'
import { FitAddon } from 'xterm-addon-fit'
import { SearchAddon } from 'xterm-addon-search'
import { useTerminalStore } from '../../stores/terminalStore'
import { useThemeStore } from '../../stores/themeStore'
import { FileExplorer } from './FileExplorer'
import { SplitTerminal } from './SplitTerminal'
import { TerminalSearch } from './TerminalSearch'
import { PortForwardPanel } from './PortForwardPanel'
import { ServerMonitor } from './ServerMonitor'
import { ContainerPanel } from './ContainerPanel'
import { RiFolderFill, RiUploadCloud2Fill, RiArrowLeftRightLine, RiPulseLine, RiHistoryLine, RiFolderTransferFill, RiStackLine } from 'react-icons/ri'
import { useSftpStore } from '../../stores/sftpStore'
import { motion, AnimatePresence } from 'framer-motion'
import { drawerVariants } from '../../lib/animation/variants'
import { useReducedMotion } from '../../hooks/useReducedMotion'
import { clampExplorerWidth, loadExplorerWidth, saveExplorerWidth, FILE_EXPLORER_DEFAULT_WIDTH } from '../../lib/fileExplorerWidth'
import { copyToClipboard, enableCopyOnSelect, isPasteShortcut } from '../../lib/terminalClipboard'
import { useTerminalCommandHistory } from '../../hooks/useTerminalCommandHistory'
import { insertIntoSession } from '../../lib/terminalInputTargets'
import { CommandHistoryPanel } from './CommandHistoryPanel'
import { ConnectionLostOverlay } from './ConnectionLostOverlay'
import { useTerminalContextMenu } from './useTerminalContextMenu'
import { registerTerminalPane } from '../../lib/terminalPanes'
import { MAIN_PANE, singlePane, layoutOf, paneBox } from '../../lib/splitTree'
import { SplitChrome, PANE_DIVIDER_PX } from './SplitChrome'
import { attachFileLinks } from './terminalFileLinks'
import { attachFileZone } from './terminalFileZone'
import { attachLogHighlight } from './terminalLogHighlight'
import 'xterm/css/xterm.css'
import { SerializeAddon } from 'xterm-addon-serialize'
import { registerTerminalSerializer, setPendingSnapshot, takePendingSnapshot, SNAPSHOT_SCROLLBACK_ROWS } from '../../lib/terminalSnapshots'

interface TerminalPanelProps {
  sessionId: string
  isActive: boolean
  onActivate: () => void
  onClose: () => void
  /** Session color; the panel itself is borderless, the color is shown on the tab instead */
  borderColor?: string
}

export function TerminalPanel({ sessionId, isActive, onActivate, onClose }: TerminalPanelProps) {
  // The SFTP panel of this tab (was the "SFTP" button under the terminal); open per tab in the store
  const isSftpOpen = useSftpStore(state => state.sessions.get(sessionId)?.isOpen === true)
  const terminalRef = useRef<HTMLDivElement>(null)
  const terminalInstance = useRef<Terminal | null>(null)
  const fitAddon = useRef<FitAddon | null>(null)
  const searchAddon = useRef<SearchAddon | null>(null)
  const isInitialized = useRef(false)

  const [showFileExplorer, setShowFileExplorer] = useState(false)
  const [explorerWidth, setExplorerWidth] = useState(loadExplorerWidth)
  const [isExplorerResizing, setIsExplorerResizing] = useState(false)
  const terminalBodyRef = useRef<HTMLDivElement>(null)
  const [isDragOver, setIsDragOver] = useState(false)
  const [uploadStatus, setUploadStatus] = useState<string | null>(null)
  const [isSearchOpen, setIsSearchOpen] = useState(false)
  const [terminalReady, setTerminalReady] = useState(false)
  const [showPortForward, setShowPortForward] = useState(false)
  const [showMonitor, setShowMonitor] = useState(false)
  const [showContainers, setShowContainers] = useState(false)
  const [showHistory, setShowHistory] = useState(false)
  const reducedMotion = useReducedMotion()
  const commandHistory = useTerminalCommandHistory(sessionId, 'main', (data) => window.electronAPI.sshSend(sessionId, data))

  const splitContainerRef = useRef<HTMLDivElement>(null)

  // Split terminal state
  const terminal = useTerminalStore(state => state.terminals.get(sessionId))
  const isSplit = terminal?.isSplit || false
  // The connection dropped: the terminal is dimmed and the "연결 끊김" card offers 재연결 / 종료
  const isDisconnected = terminal ? !terminal.connected : false
  // Where each pane sits: rectangles computed from the tab's split tree (lib/splitTree.ts)
  const splitTree = terminal?.splitTree
  const splitLayout = useMemo(() => layoutOf(splitTree ?? singlePane()), [splitTree])
  const mainRect = splitLayout.panes.find(entry => entry.pane === MAIN_PANE)?.rect
  // In a fixed order (by id), whatever their places: swapping two panes then changes only their boxes
  // and never moves their elements in the document
  const splitPanes = isSplit
    ? splitLayout.panes.filter(entry => entry.pane !== MAIN_PANE).sort((a, b) => a.pane.localeCompare(b.pane, undefined, { numeric: true }))
    : []
  const fontSize = useTerminalStore(state => state.fontSize)
  const fontFamily = useTerminalStore(state => state.fontFamily)

  const { onContextMenu: handleTerminalContextMenu, contextMenu: terminalContextMenu } = useTerminalContextMenu({
    sessionId,
    isFileExplorerOpen: showFileExplorer,
    onToggleFileExplorer: () => setShowFileExplorer(isShown => !isShown),
    onOpenSearch: () => setIsSearchOpen(true),
    onCloseSession: onClose
  })

  // Helper: fit terminal with 1 empty line at bottom for readability
  const fitTerminalWithMargin = useCallback(() => {
    if (!fitAddon.current || !terminalInstance.current) return null
    try {
      const dims = fitAddon.current.proposeDimensions()
      if (dims && dims.rows > 2) {
        const adjustedRows = dims.rows - 1
        terminalInstance.current.resize(dims.cols, adjustedRows)
        return { cols: dims.cols, rows: adjustedRows }
      }
      // Fallback: use fit() if too small
      fitAddon.current.fit()
      return dims
    } catch (e) {
      return null
    }
  }, [])

  // Buffer for detecting directory from output
  const outputBuffer = useRef('')

  useEffect(() => {
    if (!terminalRef.current || terminalInstance.current) return

    const { registerSshDataHandler, unregisterSshDataHandler } = useTerminalStore.getState()

    let term: Terminal | null = null
    let disableCopyOnSelect: (() => void) | null = null
    let detachCommandHistory: (() => void) | null = null
    let resizeObserver: ResizeObserver | null = null
    let refit: Throttled<[]> | null = null
    let unregisterSerializer: (() => void) | null = null
    let unregisterPane: (() => void) | null = null
    let serializeScreen: (() => string) | null = null
    let disposed = false
    const pendingData: string[] = []

    // Register SSH data handler with store
    const handleSshData = (data: string) => {
      if (term && isInitialized.current) {
        term.write(data)
      } else {
        // Buffer data until terminal is ready
        pendingData.push(data)
      }

      // Buffer output for directory detection
      outputBuffer.current += data
      // Keep buffer manageable
      if (outputBuffer.current.length > 2000) {
        outputBuffer.current = outputBuffer.current.slice(-1000)
      }

      // First try to extract path from terminal title escape sequence: \x1b]0;user@host:PATH\x07
      // This is more reliable as it contains the full path
      const titlePattern = /\x1b\]0;[\w\-]+@[\w\-\.]+:([\~\/][\w\/\-\.\~]*)\x07/g
      let titleMatch
      let lastTitlePath = null
      while ((titleMatch = titlePattern.exec(outputBuffer.current)) !== null) {
        lastTitlePath = titleMatch[1]
      }

      if (lastTitlePath) {
        let detectedPath = lastTitlePath
        // Convert ~ to home directory representation
        if (detectedPath === '~') {
          detectedPath = '~'  // Keep as ~ for SFTP, it can resolve home
        }
        const currentStored = useTerminalStore.getState().terminals.get(sessionId)?.currentPath
        if (currentStored !== detectedPath) {
          useTerminalStore.getState().setCurrentPath(sessionId, detectedPath)
        }
      } else {
        // Fallback: Try to detect current directory from common shell prompts
        // Patterns: user@host:/path$ , [user@host path]$ , /path> , etc.
        // Note: [\w\-]+ allows hyphens in usernames like "cloud-user"
        const patterns = [
          /[\w\-]+@[\w\-\.]+:([\~\/][\w\/\-\.\~]*)\s*[\$#>]\s*$/,  // user@host:/path$ or user@host:~$
          /\[[\w\-]+@[\w\-\.]+\s+([\~\/][\w\/\-\.\~]*)\]\s*[\$#>]\s*$/,  // [user@host path]$ or [user@host ~]$
          /(?:^|\n)(\/[\w\/\-\.]+)\s*[\$#>]\s*$/,  // /path$ or /path>
          /PWD=([\~\/][\w\/\-\.\~]+)/,  // PWD=/path or PWD=~
          /:(\~[\w\/\-\.]*)[\$#>]\s*$/,  // :~/path$ (short prompt)
        ]

        // Strip ANSI escape codes for clean pattern matching
        // eslint-disable-next-line no-control-regex
        const ansiRegex = /\x1b\[[0-9;]*[a-zA-Z]|\x1b\][^\x07]*\x07|\x1b\[\?[0-9;]*[a-zA-Z]|\r/g
        const cleanBuffer = outputBuffer.current.replace(ansiRegex, '')

        for (const pattern of patterns) {
          const match = cleanBuffer.match(pattern)
          if (match && match[1]) {
            let detectedPath = match[1]
            // Convert ~ to / for SFTP (home directory)
            if (detectedPath === '~') {
              detectedPath = '/'
            } else if (detectedPath.startsWith('~/')) {
              // Keep ~/subpath as-is, SFTP can handle it
            }
            if (detectedPath) {
              const currentStored = useTerminalStore.getState().terminals.get(sessionId)?.currentPath
              if (currentStored !== detectedPath) {
                useTerminalStore.getState().setCurrentPath(sessionId, detectedPath)
              }
            }
            break
          }
        }
      }
    }

    registerSshDataHandler(sessionId, handleSshData)

    // Delay terminal initialization to ensure DOM is ready and fonts are loaded
    const initTerminal = async () => {
      // Wait for fonts to be ready
      try {
        await document.fonts.ready
      } catch (e) {
        // Font wait failed, proceed anyway
      }

      if (disposed || !terminalRef.current) return

      // Get theme from store
      const terminalTheme = useThemeStore.getState().getTerminalTheme()
      const { fontSize, fontFamily } = useTerminalStore.getState()

      // Create terminal with dynamic theme and font settings
      term = new Terminal({
        theme: terminalTheme,
        fontSize: fontSize,
        fontFamily: `"${fontFamily}", Consolas, "D2Coding", monospace`,
        cursorBlink: true,
        cursorStyle: 'bar',
        // xterm's default 'outline' draws a box around the cursor cell in unfocused panes,
        // which looks like a double bar ('||') next to the prompt in split layouts
        cursorInactiveStyle: 'bar',
        scrollback: 10000,
        allowProposedApi: true
      })

      fitAddon.current = new FitAddon()
      term.loadAddon(fitAddon.current)

      searchAddon.current = new SearchAddon()
      term.loadAddon(searchAddon.current)

      // Screen contents travel with the tab (pop-out window, merge back, single <-> split remount)
      const serializeAddon = new SerializeAddon()
      term.loadAddon(serializeAddon)
      serializeScreen = () => serializeAddon.serialize({ scrollback: SNAPSHOT_SCROLLBACK_ROWS })
      unregisterSerializer = registerTerminalSerializer(sessionId, serializeScreen)

      term.open(terminalRef.current)
      const unregister = registerTerminalPane(terminalRef.current, term)
      // The output since the last folder change is bordered; relative names count only inside it
      const fileZone = attachFileZone(term, sessionId)
      // File and folder names under the pointer are underlined (right-click offers their actions)
      const fileLinks = attachFileLinks(term, {
        sessionId,
        lookupName: fileZone.lookup,
        getCwd: () => useTerminalStore.getState().terminals.get(sessionId)?.currentPath,
        getSessionName: () => {
          const tab = useTerminalStore.getState().terminals.get(sessionId)
          return tab ? (tab.title || `${tab.username}@${tab.host}`) : ''
        }
      })
      // Error and warning lines of logs on screen are tinted
      const logHighlight = attachLogHighlight(term)
      unregisterPane = () => {
        logHighlight.dispose()
        fileLinks.dispose()
        fileZone.dispose()
        unregister()
      }
      disableCopyOnSelect = enableCopyOnSelect(term)
      detachCommandHistory = commandHistory.attach(term)
      terminalInstance.current = term
      isInitialized.current = true

      // Handle Ctrl+C for copy when there's a selection
      term.attachCustomKeyEventHandler((event) => {
        // Ctrl+Shift+H = command history popup
        if (commandHistory.handleKeyEvent(event)) return false
        // Ctrl+C with selection = copy
        if (event.ctrlKey && event.key === 'c' && event.type === 'keydown') {
          const selection = term!.getSelection()
          if (selection) {
            copyToClipboard(selection)
            return false // Prevent default (don't send SIGINT)
          }
        }
        // Ctrl+V = paste, done by xterm from the native paste event
        if (isPasteShortcut(event)) return false
        return true // Let other keys through
      })

      // Earlier screen of this session first, then output that arrived while mounting.
      // Size the terminal first so full-screen programs (vim, top) are not restored into 80x24.
      const restored = takePendingSnapshot(sessionId)
      if (restored) {
        try {
          fitTerminalWithMargin()
        } catch {
          // Restore at the default size
        }
        term.write(restored)
      }

      // Write any buffered data
      if (pendingData.length > 0) {
        pendingData.forEach(data => term!.write(data))
        pendingData.length = 0
      }

      // Fit after a small delay to ensure renderer is ready, then apply font settings
      setTimeout(() => {
        if (fitAddon.current && !disposed) {
          try {
            // Apply current font settings from store
            const currentSettings = useTerminalStore.getState()
            term!.options.fontSize = currentSettings.fontSize
            term!.options.fontFamily = `"${currentSettings.fontFamily}", Consolas, "D2Coding", monospace`

            fitTerminalWithMargin()

            // Force refresh to apply font changes visually
            term!.refresh(0, term!.rows - 1)

            // Signal that terminal is ready for font updates
            setTerminalReady(true)

            // Open SFTP panel after 500ms to fix font metrics
            setTimeout(() => {
              if (!disposed) {
                setShowFileExplorer(true)
              }
            }, 500)
          } catch (e) {
            // Ignore
          }
        }
      }, 50)

      // Handle terminal input
      term.onData((data) => {
        commandHistory.handleData(data)
        window.electronAPI.sshSend(sessionId, data)
      })

      // Handle resize
      // Dragging a divider changes the size every frame. Refitting reflows the whole buffer, so it runs
      // at most every REFIT_INTERVAL_MS (and once at the end), and the server hears only real changes.
      let sentSize = ''
      refit = throttle(() => {
        if (fitAddon.current && isInitialized.current && !disposed) {
          try {
            const dims = fitTerminalWithMargin()
            if (dims && `${dims.cols}x${dims.rows}` !== sentSize) {
              sentSize = `${dims.cols}x${dims.rows}`
              window.electronAPI.sshResize(sessionId, dims.cols, dims.rows)
            }
          } catch (e) {
            // Ignore resize errors
          }
        }
      }, REFIT_INTERVAL_MS)
      resizeObserver = new ResizeObserver(() => refit?.())

      resizeObserver.observe(terminalRef.current)

      // Listen for theme changes
      const handleThemeChange = () => {
        if (term && !disposed) {
          const newTheme = useThemeStore.getState().getTerminalTheme()
          term.options.theme = newTheme
        }
      }
      window.addEventListener('theme-changed', handleThemeChange)

      // Listen for font size changes
      const handleFontSizeChange = (e: Event) => {
        if (term && !disposed && fitAddon.current) {
          const customEvent = e as CustomEvent
          const newFontSize = customEvent.detail.fontSize
          term.options.fontSize = newFontSize
          // Refit terminal after font size change
          setTimeout(() => {
            try {
              const dims = fitTerminalWithMargin()
              if (dims) {
                window.electronAPI.sshResize(sessionId, dims.cols, dims.rows)
              }
            } catch (e) {
              // Ignore
            }
          }, 10)
        }
      }
      window.addEventListener('terminal-font-size-changed', handleFontSizeChange)

      // Listen for font family changes
      const handleFontFamilyChange = (e: Event) => {
        if (term && !disposed && fitAddon.current) {
          const customEvent = e as CustomEvent
          const newFontFamily = customEvent.detail.fontFamily
          term.options.fontFamily = `"${newFontFamily}", Consolas, "D2Coding", monospace`
          // Refit terminal after font family change
          setTimeout(() => {
            try {
              const dims = fitTerminalWithMargin()
              if (dims) {
                window.electronAPI.sshResize(sessionId, dims.cols, dims.rows)
              }
            } catch (e) {
              // Ignore
            }
          }, 10)
        }
      }
      window.addEventListener('terminal-font-family-changed', handleFontFamilyChange)

      // Store cleanup function for theme listener
      ;(terminalRef.current as any).__themeCleanup = () => {
        window.removeEventListener('theme-changed', handleThemeChange)
        window.removeEventListener('terminal-font-size-changed', handleFontSizeChange)
        window.removeEventListener('terminal-font-family-changed', handleFontFamilyChange)
      }
    }

    // Small delay to ensure DOM is ready, then run async init
    const initTimeout = setTimeout(() => {
      initTerminal()
    }, 50)

    return () => {
      disposed = true
      clearTimeout(initTimeout)
      isInitialized.current = false
      unregisterSshDataHandler(sessionId)
      if (resizeObserver) {
        resizeObserver.disconnect()
      }
      refit?.cancel()
      // Clean up theme listener
      if (terminalRef.current && (terminalRef.current as any).__themeCleanup) {
        (terminalRef.current as any).__themeCleanup()
      }
      disableCopyOnSelect?.()
      detachCommandHistory?.()
      // Still a tab here = the layout remounted it (single <-> split): keep the screen for the new instance.
      // A removed tab (closed / popped out) keeps nothing; pop-out captures its screen beforehand.
      if (serializeScreen && useTerminalStore.getState().terminals.has(sessionId)) {
        try {
          setPendingSnapshot(sessionId, serializeScreen())
        } catch {
          // Nothing to keep
        }
      }
      unregisterSerializer?.()
      unregisterPane?.()
      if (term) {
        term.dispose()
      }
      terminalInstance.current = null
    }
  }, [sessionId])

  // Focus terminal when active
  useEffect(() => {
    if (isActive && terminalInstance.current) {
      terminalInstance.current.focus()
    }
  }, [isActive])

  // Focus on request (moving here from the sidebar), which also covers a tab that was already active.
  // Only a request newer than the last one seen counts, so a remount does not grab focus.
  const focusSeq = useTerminalStore(state => (state.focusRequest?.sessionId === sessionId ? state.focusRequest.seq : 0))
  const seenFocusSeq = useRef(focusSeq)
  useEffect(() => {
    if (focusSeq > seenFocusSeq.current) terminalInstance.current?.focus()
    seenFocusSeq.current = focusSeq
  }, [focusSeq])

  // Apply font settings from store when they change or terminal initializes
  useEffect(() => {
    if (terminalReady && terminalInstance.current) {
      const term = terminalInstance.current
      const expectedFontFamily = `"${fontFamily}", Consolas, "D2Coding", monospace`

      let needsRefit = false
      if (term.options.fontSize !== fontSize) {
        term.options.fontSize = fontSize
        needsRefit = true
      }
      if (term.options.fontFamily !== expectedFontFamily) {
        term.options.fontFamily = expectedFontFamily
        needsRefit = true
      }

      if (needsRefit && fitAddon.current) {
        setTimeout(() => {
          try {
            const dims = fitTerminalWithMargin()
            if (dims) {
              window.electronAPI.sshResize(sessionId, dims.cols, dims.rows)
            }
          } catch (e) {
            // Ignore
          }
        }, 10)
      }
    }
  }, [terminalReady, fontSize, fontFamily, sessionId])

  // Handle keyboard shortcuts
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Ctrl+F to open search
      if (e.ctrlKey && e.key === 'f') {
        e.preventDefault()
        setIsSearchOpen(true)
      }
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [])

  // Connected again (재연결 or the automatic reconnect): the new shell opened at 80x24, so tell it the real size
  const wasConnected = useRef(!isDisconnected)
  useEffect(() => {
    if (!isDisconnected && !wasConnected.current) {
      const dims = fitTerminalWithMargin()
      if (dims) window.electronAPI.sshResize(sessionId, dims.cols, dims.rows)
    }
    wasConnected.current = !isDisconnected
  }, [isDisconnected, sessionId, fitTerminalWithMargin])

  // Refit terminal when file explorer is toggled
  useEffect(() => {
    if (fitAddon.current && isInitialized.current) {
      setTimeout(() => {
        try {
          const dims = fitTerminalWithMargin()
          if (dims) {
            window.electronAPI.sshResize(sessionId, dims.cols, dims.rows)
          }
        } catch (e) {
          // Ignore
        }
      }, 100)
    }
  }, [showFileExplorer, sessionId])

  // File explorer width: drag the right edge, double-click to reset
  const handleExplorerResizeStart = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return
    e.preventDefault()
    e.stopPropagation()
    const handle = e.currentTarget
    const body = terminalBodyRef.current
    if (!body) return
    handle.setPointerCapture(e.pointerId)
    setIsExplorerResizing(true)
    const left = body.getBoundingClientRect().left
    let latest = explorerWidth

    const onMove = (ev: PointerEvent) => {
      latest = clampExplorerWidth(ev.clientX - left, body.clientWidth)
      setExplorerWidth(latest)
    }
    const onEnd = () => {
      handle.removeEventListener('pointermove', onMove)
      handle.removeEventListener('pointerup', onEnd)
      handle.removeEventListener('pointercancel', onEnd)
      setIsExplorerResizing(false)
      saveExplorerWidth(latest)
    }
    handle.addEventListener('pointermove', onMove)
    handle.addEventListener('pointerup', onEnd)
    handle.addEventListener('pointercancel', onEnd)
  }, [explorerWidth])

  const handleExplorerResizeReset = useCallback(() => {
    setExplorerWidth(FILE_EXPLORER_DEFAULT_WIDTH)
    saveExplorerWidth(FILE_EXPLORER_DEFAULT_WIDTH)
  }, [])

  const handleExplorerResizeKey = useCallback((e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return
    e.preventDefault()
    const step = e.shiftKey ? 40 : 10
    const next = clampExplorerWidth(
      explorerWidth + (e.key === 'ArrowRight' ? step : -step),
      terminalBodyRef.current?.clientWidth
    )
    setExplorerWidth(next)
    saveExplorerWidth(next)
  }, [explorerWidth])

  // Drag and drop handlers - only for file uploads, not tab drags
  const handleDragOver = useCallback((e: React.DragEvent) => {
    // Only show overlay for file drags, not internal tab drags
    if (e.dataTransfer.types.includes('Files')) {
      e.preventDefault()
      e.stopPropagation()
      setIsDragOver(true)
    }
  }, [])

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    setIsDragOver(false)
  }, [])

  const handleDrop = useCallback(async (e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    setIsDragOver(false)

    const files = Array.from(e.dataTransfer.files)
    if (files.length === 0) return

    try {
      // Open SFTP session first
      await window.electronAPI.sftpOpen(sessionId)

      // Get current working directory from terminal (default to home)
      const remotePath = '~'

      setUploadStatus(`업로드 중: ${files.length}개 파일...`)

      // File.path is gone from Electron 32 on: the preload asks webUtils for the path instead
      // (lib/droppedFiles.ts). A file with no path is counted as failed, never as uploaded.
      const { paths, missing } = droppedFilePaths(files, window.electronAPI.getPathForFile)
      for (const { name, localPath } of paths) {
        await window.electronAPI.sftpQueueUpload(sessionId, localPath, `${remotePath}/${name}`)
      }

      setUploadStatus(dropUploadStatus(paths.length, missing))
      setTimeout(() => setUploadStatus(null), 3000)
    } catch (error) {
      console.error('Upload failed:', error)
      setUploadStatus('업로드 실패')
      setTimeout(() => setUploadStatus(null), 3000)
    }
  }, [sessionId])

  return (
    <div
      className={`terminal-panel ${isActive ? 'active' : ''} ${isDragOver ? 'drag-over' : ''}`}
      role="region"
      aria-label={`Terminal for session ${sessionId}`}
      onClick={onActivate}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      <div className="terminal-header">
        <div className="terminal-header-left">
          <motion.button
            className={`terminal-header-btn ${showFileExplorer ? 'active' : ''}`}
            onClick={(e) => { e.stopPropagation(); setShowFileExplorer(!showFileExplorer); }}
            title="파일 탐색기 토글"
            whileHover={reducedMotion ? undefined : { scale: 1.1 }}
            whileTap={reducedMotion ? undefined : { scale: 0.95 }}
          >
            <RiFolderFill size={16} />
          </motion.button>
          <motion.button
            className={`terminal-header-btn ${isSftpOpen ? 'active' : ''}`}
            onClick={(e) => { e.stopPropagation(); useSftpStore.getState().setOpen(sessionId, !isSftpOpen) }}
            title={isSftpOpen ? 'SFTP 패널 닫기' : 'SFTP 패널 열기'}
            aria-pressed={isSftpOpen}
            whileHover={reducedMotion ? undefined : { scale: 1.1 }}
            whileTap={reducedMotion ? undefined : { scale: 0.95 }}
          >
            <RiFolderTransferFill size={16} />
          </motion.button>
          <div className="terminal-header-divider" />
          <motion.button
            className={`terminal-header-btn ${showPortForward ? 'active' : ''}`}
            onClick={(e) => { e.stopPropagation(); setShowPortForward(!showPortForward); }}
            title="포트 포워딩"
            whileHover={reducedMotion ? undefined : { scale: 1.1 }}
            whileTap={reducedMotion ? undefined : { scale: 0.95 }}
          >
            <RiArrowLeftRightLine size={16} />
          </motion.button>
          <motion.button
            className={`terminal-header-btn ${showMonitor ? 'active' : ''}`}
            onClick={(e) => { e.stopPropagation(); setShowMonitor(!showMonitor); setShowHistory(false); setShowContainers(false); }}
            title="서버 모니터링"
            whileHover={reducedMotion ? undefined : { scale: 1.1 }}
            whileTap={reducedMotion ? undefined : { scale: 0.95 }}
          >
            <RiPulseLine size={16} />
          </motion.button>
          <motion.button
            className={`terminal-header-btn ${showContainers ? 'active' : ''}`}
            onClick={(e) => { e.stopPropagation(); setShowContainers(!showContainers); setShowMonitor(false); setShowHistory(false); }}
            title="도커 컨테이너 (열려 있는 동안에만 서버에 묻습니다)"
            aria-pressed={showContainers}
            whileHover={reducedMotion ? undefined : { scale: 1.1 }}
            whileTap={reducedMotion ? undefined : { scale: 0.95 }}
          >
            <RiStackLine size={16} />
          </motion.button>
          <motion.button
            className={`terminal-header-btn ${showHistory ? 'active' : ''}`}
            onClick={(e) => { e.stopPropagation(); setShowHistory(!showHistory); setShowMonitor(false); setShowContainers(false); }}
            title="명령어 기록 (터미널에서 Ctrl+Shift+H 로 검색)"
            aria-pressed={showHistory}
            whileHover={reducedMotion ? undefined : { scale: 1.1 }}
            whileTap={reducedMotion ? undefined : { scale: 0.95 }}
          >
            <RiHistoryLine size={16} />
          </motion.button>
        </div>
        <div className="terminal-header-right">
          <button className="terminal-close" onClick={(e) => { e.stopPropagation(); onClose(); }}>×</button>
        </div>
      </div>
      <div ref={terminalBodyRef} className={`terminal-body ${isSplit ? 'split-tree' : ''}${isDisconnected ? ' is-disconnected' : ''}${isExplorerResizing ? ' is-explorer-resizing' : ''}`}>
        <AnimatePresence>
          {showFileExplorer && (
            <motion.div
              className="file-explorer-drawer"
              variants={reducedMotion ? undefined : drawerVariants}
              custom={{ width: explorerWidth, instant: isExplorerResizing }}
              initial="hidden"
              animate="visible"
              exit="exit"
              style={{ width: explorerWidth }}
            >
              <div
                className={`file-explorer-resize-handle${isExplorerResizing ? ' is-active' : ''}`}
                role="separator"
                aria-orientation="vertical"
                aria-label="파일 탐색기 너비 조정"
                aria-valuenow={explorerWidth}
                tabIndex={0}
                title="끌어서 너비 조정 (두 번 누르면 기본 너비)"
                onPointerDown={handleExplorerResizeStart}
                onDoubleClick={handleExplorerResizeReset}
                onKeyDown={handleExplorerResizeKey}
              />
              <FileExplorer
                sessionId={sessionId}
                onFileSelect={(path) => {
                  // Insert path into terminal
                  if (terminalInstance.current) {
                    window.electronAPI.sshSend(sessionId, path)
                  }
                }}
              />
            </motion.div>
          )}
        </AnimatePresence>
        <div
          ref={splitContainerRef}
          className="terminal-split-container"
          onContextMenu={handleTerminalContextMenu}
        >
          <div
            ref={terminalRef}
            className="terminal-container"
            data-pane={MAIN_PANE}
            style={isSplit && mainRect ? paneBox(mainRect, PANE_DIVIDER_PX) : undefined}
            role="application"
            aria-label="Terminal output"
          />
          <AnimatePresence>
            {showPortForward && (
              <PortForwardPanel
                sessionId={sessionId}
                onClose={() => setShowPortForward(false)}
              />
            )}
          </AnimatePresence>
          <AnimatePresence>
            {showMonitor && (
              <ServerMonitor
                sessionId={sessionId}
                onClose={() => setShowMonitor(false)}
              />
            )}
          </AnimatePresence>
          <AnimatePresence>
            {showContainers && (
              <ContainerPanel
                sessionId={sessionId}
                onClose={() => setShowContainers(false)}
              />
            )}
          </AnimatePresence>
          <AnimatePresence>
            {showHistory && (
              <CommandHistoryPanel
                sessionId={sessionId}
                onInsert={(command) => insertIntoSession(sessionId, command)}
                onClose={() => setShowHistory(false)}
              />
            )}
          </AnimatePresence>
          {commandHistory.popup}
          {/* Split terminals: one stably keyed wrapper per pane, all at this tree level. Only the box
              changes between layouts, so a pane that stays keeps its shell (a wrapper that moves to
              another parent or key is remounted, which closes the shell). */}
          {splitPanes.map(({ pane, rect }) => (
            <div key={`w-${pane}`} className="terminal-container split-terminal" data-pane={pane} style={paneBox(rect, PANE_DIVIDER_PX)}>
              <SplitTerminal sessionId={sessionId} pane={pane} key={pane} />
            </div>
          ))}
          {/* Divider lines, grips, drop zones and empty places (also flat children, placed the same way) */}
          {isSplit && splitTree && <SplitChrome tabId={sessionId} tree={splitTree} containerRef={splitContainerRef} />}
        </div>
        {isDisconnected && (
          <ConnectionLostOverlay
            sessionId={sessionId}
            reconnect={terminal?.reconnect}
            note={terminal?.disconnectNote}
            onClose={onClose}
            onReconnected={() => useTerminalStore.getState().setConnected(sessionId)}
            onReconnectFailed={(note) => useTerminalStore.getState().setDisconnected(sessionId, note)}
          />
        )}
      </div>

      {/* Drag overlay */}
      {isDragOver && (
        <div className="terminal-drag-overlay">
          <RiUploadCloud2Fill size={48} />
          <span>파일을 놓아 업로드</span>
        </div>
      )}

      {/* Upload status */}
      {uploadStatus && (
        <div className="terminal-upload-status">
          {uploadStatus}
        </div>
      )}

      {terminalContextMenu}

      {/* Terminal search */}
      <TerminalSearch
        searchAddon={searchAddon.current}
        isOpen={isSearchOpen}
        onClose={() => setIsSearchOpen(false)}
      />
    </div>
  )
}
