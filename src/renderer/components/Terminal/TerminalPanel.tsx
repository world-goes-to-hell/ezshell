import { useEffect, useRef, useState, useCallback } from 'react'
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
import { RiFolderFill, RiUploadCloud2Fill, RiSplitCellsHorizontal, RiSplitCellsVertical, RiArrowLeftRightLine, RiPulseLine } from 'react-icons/ri'
import { motion, AnimatePresence } from 'framer-motion'
import { drawerVariants } from '../../lib/animation/variants'
import { useReducedMotion } from '../../hooks/useReducedMotion'
import 'xterm/css/xterm.css'

interface TerminalPanelProps {
  sessionId: string
  isActive: boolean
  onActivate: () => void
  onClose: () => void
  borderColor?: string
}

export function TerminalPanel({ sessionId, isActive, onActivate, onClose, borderColor }: TerminalPanelProps) {
  const terminalRef = useRef<HTMLDivElement>(null)
  const terminalInstance = useRef<Terminal | null>(null)
  const fitAddon = useRef<FitAddon | null>(null)
  const searchAddon = useRef<SearchAddon | null>(null)
  const isInitialized = useRef(false)

  const [showFileExplorer, setShowFileExplorer] = useState(false)
  const [isDragOver, setIsDragOver] = useState(false)
  const [uploadStatus, setUploadStatus] = useState<string | null>(null)
  const [isSearchOpen, setIsSearchOpen] = useState(false)
  const [terminalReady, setTerminalReady] = useState(false)
  const [mergeMenu, setMergeMenu] = useState<{x: number; y: number; options: Array<{label: string; action: () => void}>} | null>(null)
  const [showPortForward, setShowPortForward] = useState(false)
  const [showMonitor, setShowMonitor] = useState(false)
  const reducedMotion = useReducedMotion()

  // Split resize state
  const [termSplitRatio, setTermSplitRatio] = useState(0.5)
  const [isTermSplitResizing, setIsTermSplitResizing] = useState(false)
  const [gridColRatio, setGridColRatio] = useState(0.5)
  const [gridRowRatio, setGridRowRatio] = useState(0.5)
  const [gridResizeAxis, setGridResizeAxis] = useState<'col' | 'row' | 'both' | null>(null)
  const splitContainerRef = useRef<HTMLDivElement>(null)

  // Split terminal state
  const terminal = useTerminalStore(state => state.terminals.get(sessionId))
  const isSplit = terminal?.isSplit || false
  const splitDirection = useTerminalStore(state => state.getSplitDirection(sessionId)) || 'horizontal'
  const splitSlots = terminal?.splitSlots || []
  const setSplit = useTerminalStore(state => state.setSplit)
  const isMultiSplit = isSplit && splitDirection !== 'horizontal' && splitDirection !== 'vertical'
  const fontSize = useTerminalStore(state => state.fontSize)
  const fontFamily = useTerminalStore(state => state.fontFamily)

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
    let resizeObserver: ResizeObserver | null = null
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
        scrollback: 10000,
        allowProposedApi: true
      })

      fitAddon.current = new FitAddon()
      term.loadAddon(fitAddon.current)

      searchAddon.current = new SearchAddon()
      term.loadAddon(searchAddon.current)

      term.open(terminalRef.current)
      terminalInstance.current = term
      isInitialized.current = true

      // Handle Ctrl+C for copy when there's a selection
      term.attachCustomKeyEventHandler((event) => {
        // Ctrl+C with selection = copy
        if (event.ctrlKey && event.key === 'c' && event.type === 'keydown') {
          const selection = term!.getSelection()
          if (selection) {
            navigator.clipboard.writeText(selection)
            return false // Prevent default (don't send SIGINT)
          }
        }
        // Ctrl+V = paste
        if (event.ctrlKey && event.key === 'v' && event.type === 'keydown') {
          navigator.clipboard.readText().then(text => {
            if (text) {
              window.electronAPI.sshSend(sessionId, text)
            }
          })
          return false
        }
        return true // Let other keys through
      })

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
        window.electronAPI.sshSend(sessionId, data)
      })

      // Handle resize
      resizeObserver = new ResizeObserver(() => {
        if (fitAddon.current && isInitialized.current && !disposed) {
          try {
            const dims = fitTerminalWithMargin()
            if (dims) {
              window.electronAPI.sshResize(sessionId, dims.cols, dims.rows)
            }
          } catch (e) {
            // Ignore resize errors
          }
        }
      })

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
      // Clean up theme listener
      if (terminalRef.current && (terminalRef.current as any).__themeCleanup) {
        (terminalRef.current as any).__themeCleanup()
      }
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

      for (const file of files) {
        const localPath = (file as any).path
        if (localPath) {
          const remoteFilePath = `${remotePath}/${file.name}`
          await window.electronAPI.sftpQueueUpload(sessionId, localPath, remoteFilePath)
        }
      }

      setUploadStatus(`${files.length}개 파일 업로드 완료`)
      setTimeout(() => setUploadStatus(null), 3000)
    } catch (error) {
      console.error('Upload failed:', error)
      setUploadStatus('업로드 실패')
      setTimeout(() => setUploadStatus(null), 3000)
    }
  }, [sessionId])

  // Terminal 2-split resize via divider drag
  useEffect(() => {
    if (!isTermSplitResizing) return

    const handleMouseMove = (e: MouseEvent) => {
      const container = splitContainerRef.current
      if (!container) return
      const rect = container.getBoundingClientRect()
      let ratio: number
      if (splitDirection === 'horizontal') {
        ratio = (e.clientX - rect.left) / rect.width
      } else {
        ratio = (e.clientY - rect.top) / rect.height
      }
      ratio = Math.min(0.8, Math.max(0.2, ratio))
      setTermSplitRatio(ratio)
    }

    const handleMouseUp = () => {
      setIsTermSplitResizing(false)
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
  }, [isTermSplitResizing, splitDirection])

  // Grid split resize via divider drag
  useEffect(() => {
    if (!gridResizeAxis) return

    const handleMouseMove = (e: MouseEvent) => {
      const container = splitContainerRef.current
      if (!container) return
      const rect = container.getBoundingClientRect()

      if (gridResizeAxis === 'col' || gridResizeAxis === 'both') {
        const colRatio = (e.clientX - rect.left) / rect.width
        setGridColRatio(Math.min(0.8, Math.max(0.2, colRatio)))
      }
      if (gridResizeAxis === 'row' || gridResizeAxis === 'both') {
        const rowRatio = (e.clientY - rect.top) / rect.height
        setGridRowRatio(Math.min(0.8, Math.max(0.2, rowRatio)))
      }
    }

    const handleMouseUp = () => {
      setGridResizeAxis(null)
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
  }, [gridResizeAxis])

  return (
    <div
      className={`terminal-panel ${isActive ? 'active' : ''} ${isDragOver ? 'drag-over' : ''}`}
      role="region"
      aria-label={`Terminal for session ${sessionId}`}
      onClick={onActivate}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
      style={borderColor ? {
        border: `2px solid ${borderColor}`,
        borderRadius: '4px',
      } : undefined}
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
            <RiFolderFill size={14} />
          </motion.button>
          <div className="terminal-header-divider" />
          <motion.button
            className={`terminal-header-btn ${isSplit && splitDirection !== 'vertical' ? 'active' : ''}`}
            onClick={(e) => {
              e.stopPropagation();
              if (!isSplit) {
                setSplit(sessionId, true, 'horizontal')
              } else if (splitDirection === 'horizontal') {
                setSplit(sessionId, false)
              } else if (splitDirection === 'vertical') {
                setSplit(sessionId, true, 'quad')
              } else {
                // quad or any tri → vertical
                setSplit(sessionId, true, 'vertical')
              }
            }}
            title="가로 분할"
            whileHover={reducedMotion ? undefined : { scale: 1.1 }}
            whileTap={reducedMotion ? undefined : { scale: 0.95 }}
          >
            <RiSplitCellsHorizontal size={14} />
          </motion.button>
          <motion.button
            className={`terminal-header-btn ${isSplit && splitDirection !== 'horizontal' ? 'active' : ''}`}
            onClick={(e) => {
              e.stopPropagation();
              if (!isSplit) {
                setSplit(sessionId, true, 'vertical')
              } else if (splitDirection === 'vertical') {
                setSplit(sessionId, false)
              } else if (splitDirection === 'horizontal') {
                setSplit(sessionId, true, 'quad')
              } else {
                // quad or any tri → horizontal
                setSplit(sessionId, true, 'horizontal')
              }
            }}
            title="세로 분할"
            whileHover={reducedMotion ? undefined : { scale: 1.1 }}
            whileTap={reducedMotion ? undefined : { scale: 0.95 }}
          >
            <RiSplitCellsVertical size={14} />
          </motion.button>
          <div className="terminal-header-divider" />
          <motion.button
            className={`terminal-header-btn ${showPortForward ? 'active' : ''}`}
            onClick={(e) => { e.stopPropagation(); setShowPortForward(!showPortForward); }}
            title="포트 포워딩"
            whileHover={reducedMotion ? undefined : { scale: 1.1 }}
            whileTap={reducedMotion ? undefined : { scale: 0.95 }}
          >
            <RiArrowLeftRightLine size={14} />
          </motion.button>
          <motion.button
            className={`terminal-header-btn ${showMonitor ? 'active' : ''}`}
            onClick={(e) => { e.stopPropagation(); setShowMonitor(!showMonitor); }}
            title="서버 모니터링"
            whileHover={reducedMotion ? undefined : { scale: 1.1 }}
            whileTap={reducedMotion ? undefined : { scale: 0.95 }}
          >
            <RiPulseLine size={14} />
          </motion.button>
        </div>
        <div className="terminal-header-right">
          <button className="terminal-close" onClick={(e) => { e.stopPropagation(); onClose(); }}>×</button>
        </div>
      </div>
      <div className={`terminal-body ${isSplit ? `split-${splitDirection}` : ''}`}>
        <AnimatePresence>
          {showFileExplorer && (
            <motion.div
              variants={reducedMotion ? undefined : drawerVariants}
              initial="hidden"
              animate="visible"
              exit="exit"
              style={{ overflow: 'hidden' }}
            >
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
          style={isMultiSplit ? {
            gridTemplateColumns: `${gridColRatio}fr 6px ${1 - gridColRatio}fr`,
            gridTemplateRows: `${gridRowRatio}fr 6px ${1 - gridRowRatio}fr`
          } : undefined}
        >
          <div
            ref={terminalRef}
            className="terminal-container"
            style={isMultiSplit ? (
              splitDirection === 'tri-bottom' ? { gridRow: '1', gridColumn: '1 / 4' } :
              splitDirection === 'tri-right' ? { gridRow: '1 / 4', gridColumn: '1' } :
              { gridRow: '1', gridColumn: '1' }
            ) : { flex: isSplit ? termSplitRatio : undefined }}
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
          {/* Simple 2-split (horizontal/vertical) */}
          {isSplit && (splitDirection === 'horizontal' || splitDirection === 'vertical') && (
            <>
              <div
                className={`terminal-split-divider ${splitDirection}`}
                onMouseDown={(e) => { e.preventDefault(); setIsTermSplitResizing(true) }}
                title="드래그로 크기 조절"
              />
              <div className="terminal-container split-terminal" style={{ flex: 1 - termSplitRatio }}>
                <SplitTerminal sessionId={sessionId} key="split-1" />
              </div>
            </>
          )}
          {/* Multi-split dividers (layout-specific, stateless) */}
          {splitDirection === 'quad' && (
            <>
              <div className="grid-divider grid-divider-v" style={{ gridRow: '1', gridColumn: '2' }}
                onMouseDown={(e) => { e.preventDefault(); setGridResizeAxis('col') }}
                onContextMenu={(e) => { e.preventDefault(); e.stopPropagation(); setMergeMenu({ x: e.clientX, y: e.clientY, options: [
                  { label: '병합', action: () => { setSplit(sessionId, true, 'tri-bottom', ['split-2', 'split-3']); setMergeMenu(null) } }
                ]})}} />
              <div className="grid-divider grid-divider-h" style={{ gridRow: '2', gridColumn: '1' }}
                onMouseDown={(e) => { e.preventDefault(); setGridResizeAxis('row') }}
                onContextMenu={(e) => { e.preventDefault(); e.stopPropagation(); setMergeMenu({ x: e.clientX, y: e.clientY, options: [
                  { label: '병합', action: () => { setSplit(sessionId, true, 'tri-right', ['split-1', 'split-3']); setMergeMenu(null) } }
                ]})}} />
              <div className="grid-divider grid-divider-center" style={{ gridRow: '2', gridColumn: '2' }}
                onMouseDown={(e) => { e.preventDefault(); setGridResizeAxis('both') }} />
              <div className="grid-divider grid-divider-h" style={{ gridRow: '2', gridColumn: '3' }}
                onMouseDown={(e) => { e.preventDefault(); setGridResizeAxis('row') }}
                onContextMenu={(e) => { e.preventDefault(); e.stopPropagation(); setMergeMenu({ x: e.clientX, y: e.clientY, options: [
                  { label: '2번 터미널 기준 병합', action: () => { setSplit(sessionId, true, 'tri-left', ['split-2', 'split-1']); setMergeMenu(null) } },
                  { label: '4번 터미널 기준 병합', action: () => { setSplit(sessionId, true, 'tri-left', ['split-2', 'split-3']); setMergeMenu(null) } },
                ]})}} />
              <div className="grid-divider grid-divider-v" style={{ gridRow: '3', gridColumn: '2' }}
                onMouseDown={(e) => { e.preventDefault(); setGridResizeAxis('col') }}
                onContextMenu={(e) => { e.preventDefault(); e.stopPropagation(); setMergeMenu({ x: e.clientX, y: e.clientY, options: [
                  { label: '3번 터미널 기준 병합', action: () => { setSplit(sessionId, true, 'tri-top', ['split-1', 'split-2']); setMergeMenu(null) } },
                  { label: '4번 터미널 기준 병합', action: () => { setSplit(sessionId, true, 'tri-top', ['split-1', 'split-3']); setMergeMenu(null) } },
                ]})}} />
            </>
          )}
          {splitDirection === 'tri-bottom' && (
            <>
              <div className="grid-divider grid-divider-h" style={{ gridRow: '2', gridColumn: '1 / 4' }}
                onMouseDown={(e) => { e.preventDefault(); setGridResizeAxis('row') }} />
              <div className="grid-divider grid-divider-v" style={{ gridRow: '3', gridColumn: '2' }}
                onMouseDown={(e) => { e.preventDefault(); setGridResizeAxis('col') }} />
            </>
          )}
          {splitDirection === 'tri-top' && (
            <>
              <div className="grid-divider grid-divider-v" style={{ gridRow: '1', gridColumn: '2' }}
                onMouseDown={(e) => { e.preventDefault(); setGridResizeAxis('col') }} />
              <div className="grid-divider grid-divider-h" style={{ gridRow: '2', gridColumn: '1 / 4' }}
                onMouseDown={(e) => { e.preventDefault(); setGridResizeAxis('row') }} />
            </>
          )}
          {splitDirection === 'tri-right' && (
            <>
              <div className="grid-divider grid-divider-v" style={{ gridRow: '1 / 4', gridColumn: '2' }}
                onMouseDown={(e) => { e.preventDefault(); setGridResizeAxis('col') }} />
              <div className="grid-divider grid-divider-h" style={{ gridRow: '2', gridColumn: '3' }}
                onMouseDown={(e) => { e.preventDefault(); setGridResizeAxis('row') }} />
            </>
          )}
          {splitDirection === 'tri-left' && (
            <>
              <div className="grid-divider grid-divider-h" style={{ gridRow: '2', gridColumn: '1' }}
                onMouseDown={(e) => { e.preventDefault(); setGridResizeAxis('row') }} />
              <div className="grid-divider grid-divider-v" style={{ gridRow: '1 / 4', gridColumn: '2' }}
                onMouseDown={(e) => { e.preventDefault(); setGridResizeAxis('col') }} />
            </>
          )}
          {/* Multi-split terminals - keyed at same tree level for stable reconciliation */}
          {isMultiSplit && (splitDirection === 'quad' || splitSlots.includes('split-1')) && (
            <div key="w-split-1" className="terminal-container split-terminal" style={
              splitDirection === 'quad' ? { gridRow: '1', gridColumn: '3' } :
              splitDirection === 'tri-top' ? { gridRow: '1', gridColumn: '3' } :
              splitDirection === 'tri-right' ? { gridRow: '1', gridColumn: '3' } :
              splitDirection === 'tri-left' && splitSlots[0] === 'split-1' ? { gridRow: '3', gridColumn: '1' } :
              splitDirection === 'tri-left' && splitSlots[1] === 'split-1' ? { gridRow: '1 / 4', gridColumn: '3' } :
              {}
            }>
              <SplitTerminal sessionId={sessionId} key="split-1" />
            </div>
          )}
          {isMultiSplit && (splitDirection === 'quad' || splitSlots.includes('split-2')) && (
            <div key="w-split-2" className="terminal-container split-terminal" style={
              splitDirection === 'quad' ? { gridRow: '3', gridColumn: '1' } :
              splitDirection === 'tri-bottom' && splitSlots[0] === 'split-2' ? { gridRow: '3', gridColumn: '1' } :
              splitDirection === 'tri-bottom' && splitSlots[1] === 'split-2' ? { gridRow: '3', gridColumn: '3' } :
              splitDirection === 'tri-top' && splitSlots[1] === 'split-2' ? { gridRow: '3', gridColumn: '1 / 4' } :
              splitDirection === 'tri-left' && splitSlots[0] === 'split-2' ? { gridRow: '3', gridColumn: '1' } :
              {}
            }>
              <SplitTerminal sessionId={sessionId} key="split-2" delay={200} />
            </div>
          )}
          {isMultiSplit && (splitDirection === 'quad' || splitSlots.includes('split-3')) && (
            <div key="w-split-3" className="terminal-container split-terminal" style={
              splitDirection === 'quad' ? { gridRow: '3', gridColumn: '3' } :
              splitDirection === 'tri-bottom' && splitSlots[0] === 'split-3' ? { gridRow: '3', gridColumn: '1' } :
              splitDirection === 'tri-bottom' && splitSlots[1] === 'split-3' ? { gridRow: '3', gridColumn: '3' } :
              splitDirection === 'tri-top' && splitSlots[1] === 'split-3' ? { gridRow: '3', gridColumn: '1 / 4' } :
              splitDirection === 'tri-right' && splitSlots[1] === 'split-3' ? { gridRow: '3', gridColumn: '3' } :
              splitDirection === 'tri-left' && splitSlots[1] === 'split-3' ? { gridRow: '1 / 4', gridColumn: '3' } :
              {}
            }>
              <SplitTerminal sessionId={sessionId} key="split-3" delay={400} />
            </div>
          )}
        </div>
      </div>

      {/* Merge context menu */}
      {mergeMenu && (
        <>
          <div className="split-context-overlay" onClick={() => setMergeMenu(null)} onContextMenu={(e) => { e.preventDefault(); setMergeMenu(null) }} />
          <div className="split-context-menu" style={{ left: mergeMenu.x, top: mergeMenu.y }}>
            {mergeMenu.options.map((option, i) => (
              <div key={i} className="split-context-menu-item" onClick={option.action}>
                {option.label}
              </div>
            ))}
          </div>
        </>
      )}

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

      {/* Terminal search */}
      <TerminalSearch
        searchAddon={searchAddon.current}
        isOpen={isSearchOpen}
        onClose={() => setIsSearchOpen(false)}
      />
    </div>
  )
}
