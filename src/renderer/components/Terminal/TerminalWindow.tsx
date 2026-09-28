import { useEffect, useRef } from 'react'
import { Terminal } from 'xterm'
import { FitAddon } from 'xterm-addon-fit'
import { useThemeStore } from '../../stores/themeStore'
import { RiSubtractFill, RiCheckboxBlankFill, RiCloseFill, RiTerminalBoxFill, RiMergeCellsHorizontal } from 'react-icons/ri'
import { enableCopyOnSelect } from '../../lib/terminalClipboard'
import 'xterm/css/xterm.css'

interface TerminalWindowProps {
  sessionId: string
  title: string
}

export function TerminalWindow({ sessionId, title }: TerminalWindowProps) {
  const terminalRef = useRef<HTMLDivElement>(null)
  const terminalInstance = useRef<Terminal | null>(null)
  const fitAddon = useRef<FitAddon | null>(null)
  const isInitialized = useRef(false)

  // Initialize theme for popout window
  useEffect(() => {
    useThemeStore.getState().initializeTheme()
  }, [])

  useEffect(() => {
    if (!terminalRef.current || terminalInstance.current) return

    let term: Terminal | null = null
    let disableCopyOnSelect: (() => void) | null = null
    let resizeObserver: ResizeObserver | null = null
    let disposed = false
    const pendingData: string[] = []

    const handleSshData = (data: string) => {
      if (term && isInitialized.current) {
        term.write(data)
      } else {
        pendingData.push(data)
      }
    }

    // Set up IPC listener for SSH data directly in this window
    const unsubscribe = window.electronAPI.onSshData((eventData: { sessionId: string; data: string }) => {
      if (eventData.sessionId === sessionId) {
        handleSshData(eventData.data)
      }
    })

    const initTimeout = setTimeout(() => {
      if (disposed || !terminalRef.current) return

      // Get theme from store
      const terminalTheme = useThemeStore.getState().getTerminalTheme()

      term = new Terminal({
        theme: terminalTheme,
        fontSize: 14,
        fontFamily: '"JetBrains Mono", Consolas, "D2Coding", monospace',
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

      term.open(terminalRef.current)
      disableCopyOnSelect = enableCopyOnSelect(term)
      terminalInstance.current = term
      isInitialized.current = true

      if (pendingData.length > 0) {
        pendingData.forEach(data => term!.write(data))
        pendingData.length = 0
      }

      setTimeout(() => {
        if (fitAddon.current && !disposed) {
          try {
            fitAddon.current.fit()
          } catch (e) {
            // Ignore
          }
        }
      }, 50)

      term.onData((data) => {
        window.electronAPI.sshSend(sessionId, data)
      })

      resizeObserver = new ResizeObserver(() => {
        if (fitAddon.current && isInitialized.current && !disposed) {
          try {
            fitAddon.current.fit()
            const dims = fitAddon.current.proposeDimensions()
            if (dims) {
              window.electronAPI.sshResize(sessionId, dims.cols, dims.rows)
            }
          } catch (e) {
            // Ignore resize errors
          }
        }
      })

      resizeObserver.observe(terminalRef.current)
      term.focus()

      // Listen for theme changes
      const handleThemeChange = () => {
        if (term && !disposed) {
          const newTheme = useThemeStore.getState().getTerminalTheme()
          term.options.theme = newTheme
        }
      }
      window.addEventListener('theme-changed', handleThemeChange)

      // Store cleanup function
      ;(terminalRef.current as any).__themeCleanup = () => {
        window.removeEventListener('theme-changed', handleThemeChange)
      }
    }, 50)

    return () => {
      disposed = true
      clearTimeout(initTimeout)
      isInitialized.current = false
      unsubscribe()
      if (resizeObserver) {
        resizeObserver.disconnect()
      }
      // Clean up theme listener
      if (terminalRef.current && (terminalRef.current as any).__themeCleanup) {
        (terminalRef.current as any).__themeCleanup()
      }
      disableCopyOnSelect?.()
      if (term) {
        term.dispose()
      }
      terminalInstance.current = null
    }
  }, [sessionId])

  return (
    <div className="terminal-window-container">
      <div className="title-bar">
        <div className="title-bar-drag">
          <RiTerminalBoxFill size={18} style={{ color: 'var(--accent)' }} />
          <span className="title-bar-title">{title}</span>
        </div>
        <div className="title-bar-controls">
          <button
            className="title-bar-btn"
            onClick={() => {
              // Parse title to get host/username (format: "username@host" or custom title)
              const parts = title.split('@')
              const username = parts.length > 1 ? parts[0] : ''
              const host = parts.length > 1 ? parts[1] : title
              window.electronAPI.mergeTerminalToMain(sessionId, title, host, username)
            }}
            title="메인 창으로 병합"
          >
            <RiMergeCellsHorizontal size={16} />
          </button>
          <button className="title-bar-btn" onClick={() => window.electronAPI.minimizeWindow()}>
            <RiSubtractFill size={16} />
          </button>
          <button className="title-bar-btn" onClick={() => window.electronAPI.maximizeWindow()}>
            <RiCheckboxBlankFill size={16} />
          </button>
          <button className="title-bar-btn title-bar-close" onClick={() => window.electronAPI.closeWindow()}>
            <RiCloseFill size={16} />
          </button>
        </div>
      </div>
      <div ref={terminalRef} className="terminal-window-content" />
    </div>
  )
}
