import { useEffect, useRef } from 'react'
import { Terminal } from 'xterm'
import { FitAddon } from 'xterm-addon-fit'
import { SerializeAddon } from 'xterm-addon-serialize'
import { useThemeStore } from '../../stores/themeStore'
import { RiTerminalBoxFill, RiMergeCellsHorizontal } from 'react-icons/ri'
import { enableCopyOnSelect } from '../../lib/terminalClipboard'
import { SNAPSHOT_SCROLLBACK_ROWS } from '../../lib/terminalSnapshots'
import { PopoutTitleBar } from '../TitleBar/PopoutTitleBar'
import { usePopoutTheme } from '../../hooks/usePopoutTheme'
import { usePopoutHostLabel } from '../../hooks/usePopoutHostLabel'
import 'xterm/css/xterm.css'

interface TerminalWindowProps {
  sessionId: string
  title: string
}

// Same defaults as the main window's terminal store
const DEFAULT_FONT_SIZE = 14
const DEFAULT_FONT_FAMILY = 'JetBrains Mono'

/** Terminal font the user picked in settings (the popout has no terminal store of its own) */
async function loadTerminalFont(): Promise<{ fontSize: number; fontFamily: string }> {
  try {
    const settings = await window.electronAPI.loadSettings()
    return {
      fontSize: settings?.terminalFontSize || DEFAULT_FONT_SIZE,
      fontFamily: settings?.terminalFontFamily || DEFAULT_FONT_FAMILY
    }
  } catch {
    return { fontSize: DEFAULT_FONT_SIZE, fontFamily: DEFAULT_FONT_FAMILY }
  }
}

export function TerminalWindow({ sessionId, title }: TerminalWindowProps) {
  usePopoutTheme()
  const hostLabel = usePopoutHostLabel(sessionId)
  const terminalRef = useRef<HTMLDivElement>(null)
  const terminalInstance = useRef<Terminal | null>(null)
  const fitAddon = useRef<FitAddon | null>(null)
  const serializeAddon = useRef<SerializeAddon | null>(null)
  const isInitialized = useRef(false)

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

    const handleThemeChange = () => {
      if (term && !disposed) term.options.theme = useThemeStore.getState().getTerminalTheme()
    }

    const initTerminal = async () => {
      // Screen of the tab this window came from, and the user's terminal font
      const [snapshot, font] = await Promise.all([
        window.electronAPI.takeTerminalSnapshot?.(sessionId).catch(() => null) ?? Promise.resolve(null),
        loadTerminalFont()
      ])
      if (disposed || !terminalRef.current) return

      term = new Terminal({
        theme: useThemeStore.getState().getTerminalTheme(),
        fontSize: font.fontSize,
        fontFamily: `"${font.fontFamily}", Consolas, "D2Coding", monospace`,
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
      serializeAddon.current = new SerializeAddon()
      term.loadAddon(serializeAddon.current)

      term.open(terminalRef.current)
      disableCopyOnSelect = enableCopyOnSelect(term)
      terminalInstance.current = term
      isInitialized.current = true

      // Earlier screen first, then output that arrived while the window was opening.
      // Size the terminal first so full-screen programs (vim, top) are not restored into 80x24.
      if (snapshot) {
        try {
          fitAddon.current.fit()
        } catch {
          // Restore at the default size
        }
        term.write(snapshot)
      }
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
      window.addEventListener('theme-changed', handleThemeChange)
    }

    const initTimeout = setTimeout(() => { void initTerminal() }, 50)

    return () => {
      disposed = true
      clearTimeout(initTimeout)
      isInitialized.current = false
      unsubscribe()
      resizeObserver?.disconnect()
      window.removeEventListener('theme-changed', handleThemeChange)
      disableCopyOnSelect?.()
      term?.dispose()
      terminalInstance.current = null
      serializeAddon.current = null
    }
  }, [sessionId])

  // Output in the few ms between this serialize and the main process routing data back to the main
  // window is not carried over; this window closes right after.
  const handleMerge = async () => {
    let snapshot: string | undefined
    try {
      snapshot = serializeAddon.current?.serialize({ scrollback: SNAPSHOT_SCROLLBACK_ROWS }) || undefined
    } catch {
      // Merge without the screen
    }
    const info = await window.electronAPI.sshGetSessionInfo(sessionId).catch(() => null)
    window.electronAPI.mergeTerminalToMain(sessionId, title, info?.host ?? '', info?.username ?? '', snapshot)
  }

  return (
    <div className="terminal-window-container">
      <PopoutTitleBar
        icon={<RiTerminalBoxFill size={16} />}
        title={title}
        subtitle={hostLabel && hostLabel !== title ? hostLabel : undefined}
        actions={
          <button className="title-bar-btn popout-title-action" onClick={handleMerge} title="메인 창으로 병합" aria-label="메인 창으로 병합">
            <RiMergeCellsHorizontal size={16} />
          </button>
        }
      />
      <div ref={terminalRef} className="terminal-window-content" />
    </div>
  )
}
