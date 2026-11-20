import { useEffect, useRef, useState } from 'react'
import { throttle, REFIT_INTERVAL_MS, type Throttled } from '../../lib/throttle'
import { SerializeAddon } from 'xterm-addon-serialize'
import { registerSplitShell } from '../../lib/splitShells'
import { claimIncomingShell, forgetIncomingShell, isIncomingShell, markIncomingDrawn, releaseIncomingShell } from '../../lib/incomingShells'
import { SNAPSHOT_SCROLLBACK_ROWS } from '../../lib/terminalSnapshots'
import type { PaneId } from '../../lib/splitTree'
import { Terminal } from 'xterm'
import { FitAddon } from 'xterm-addon-fit'
import { useThemeStore } from '../../stores/themeStore'
import { useTerminalStore } from '../../stores/terminalStore'
import { copyToClipboard, enableCopyOnSelect, isPasteShortcut } from '../../lib/terminalClipboard'
import { useTerminalCommandHistory } from '../../hooks/useTerminalCommandHistory'
import 'xterm/css/xterm.css'
import { attachLogHighlight } from './terminalLogHighlight'
import { attachTerminalWebLinks } from './terminalWebLinks'
import { registerTerminalPane } from '../../lib/terminalPanes'
import { createEarlyStreamBuffer } from '../../lib/earlyStreamBuffer'
import { createRightClickFilter } from '../../lib/rightClickReports'

interface SplitTerminalProps {
  sessionId: string
  /** Which pane of the tab this shell is drawn in (lib/splitTree.ts) */
  pane: PaneId
  delay?: number
}

const MAX_AUTO_RETRIES = 3
const BASE_RETRY_DELAY = 1000 // 1 second

export function SplitTerminal({ sessionId, pane, delay = 0 }: SplitTerminalProps) {
  const terminalRef = useRef<HTMLDivElement>(null)
  const terminalInstance = useRef<Terminal | null>(null)
  const fitAddon = useRef<FitAddon | null>(null)
  const isInitialized = useRef(false)
  const streamIdRef = useRef<string | null>(null)
  const [status, setStatus] = useState<'connecting' | 'connected' | 'error'>('connecting')
  const [errorMsg, setErrorMsg] = useState<string>('')
  const [terminalReady, setTerminalReady] = useState(false)
  const [retryCount, setRetryCount] = useState(0)
  const autoRetryCount = useRef(0)
  const commandHistory = useTerminalCommandHistory(sessionId, 'split', (data) => {
    if (streamIdRef.current) window.electronAPI.sshSplitSend(streamIdRef.current, data)
  })

  const fontSize = useTerminalStore(state => state.fontSize)
  const fontFamily = useTerminalStore(state => state.fontFamily)

  // Apply font settings from store when they change
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
            fitAddon.current?.fit()
            const dims = fitAddon.current?.proposeDimensions()
            if (dims && streamIdRef.current) {
              window.electronAPI.sshSplitResize(streamIdRef.current, dims.cols, dims.rows)
            }
          } catch (e) {
            // Ignore
          }
        }, 10)
      }
    }
  }, [terminalReady, fontSize, fontFamily])

  useEffect(() => {
    let term: Terminal | null = null
    let disableCopyOnSelect: (() => void) | null = null
    let unregisterPane: (() => void) | null = null
    let detachCommandHistory: (() => void) | null = null
    let resizeObserver: ResizeObserver | null = null
    let refit: Throttled<[]> | null = null
    let disposed = false
    let delayTimer: ReturnType<typeof setTimeout> | null = null
    let serializeScreen: (() => string) | null = null
    // The pane can give its shell up (it becomes a tab, lib/paneToTab.ts): everything received so
    // far is drawn, the screen is taken, and this pane lets go of the channel without closing it
    const unregisterShell = registerSplitShell(sessionId, pane, {
      streamId: () => (isInitialized.current ? streamIdRef.current : null),
      detach: async () => {
        const terminal = terminalInstance.current
        let screen = ''
        if (terminal && serializeScreen) {
          await new Promise<void>(resolve => terminal.write('', () => resolve()))
          try { screen = serializeScreen() } catch { screen = '' }
        }
        streamIdRef.current = null
        isInitialized.current = false
        forgetIncomingShell(sessionId, pane)
        return screen
      }
    })
    // Split output that arrives before this pane can show it (see handleSplitData)
    const earlyOutput = createEarlyStreamBuffer()
    // A tab merged into this pane: its shell is already open and is taken over instead of opening one
    // (lib/tabToPane.ts). Claimed here, in the same tick the listeners below start, so its output is
    // neither missed nor held twice.
    const incoming = claimIncomingShell(sessionId, pane)
    if (incoming) {
      streamIdRef.current = incoming.streamId
      if (incoming.output) earlyOutput.push(incoming.streamId, incoming.output)
    }

    // Reset state on retry
    setStatus('connecting')
    setErrorMsg('')
    setTerminalReady(false)

    const initTerminal = async () => {
      // Always yield at least one macrotask before opening the channel (and stagger by `delay`).
      // StrictMode's dev-only mount/unmount/mount disposes the first run during that tick,
      // so it never opens a shell; otherwise every split briefly held two channels and a quad
      // layout could hit the server's MaxSessions (10) and fail.
      await new Promise<void>(resolve => {
        delayTimer = setTimeout(resolve, delay)
      })

      if (disposed) return

      // Create a new independent shell channel first
      try {
        console.log('Creating split shell for session:', sessionId)
        const result = incoming
          ? { success: true, streamId: incoming.streamId }
          : await window.electronAPI.sshCreateShell(sessionId)
        if (!result.success) {
          console.warn('Split shell creation failed:', result.error)
          // Auto-retry with exponential backoff
          if (autoRetryCount.current < MAX_AUTO_RETRIES && !disposed) {
            autoRetryCount.current++
            const retryDelay = BASE_RETRY_DELAY * Math.pow(2, autoRetryCount.current - 1)
            console.log(`Split shell creation failed, auto-retry ${autoRetryCount.current}/${MAX_AUTO_RETRIES} in ${retryDelay}ms`)
            await new Promise<void>(resolve => {
              delayTimer = setTimeout(resolve, retryDelay)
            })
            if (!disposed) {
              return initTerminal()
            }
            return
          }
          setErrorMsg(result.error || '쉘 생성 실패')
          setStatus('error')
          return
        }

        if (disposed) {
          // Unmounted while the shell was being opened (fast split toggle, or StrictMode's
          // dev-only mount/unmount/mount). Nobody owns this channel, so close it now;
          // otherwise it stays open on the server and eventually hits MaxSessions.
          // (A shell taken over from a tab was let go by the cleanup already.)
          if (result.streamId && !incoming) window.electronAPI.sshSplitClose(result.streamId)
          return
        }

        streamIdRef.current = result.streamId ?? null

        // Wait for DOM to be ready
        const waitForRef = () => {
          return new Promise<void>((resolve) => {
            const check = () => {
              if (terminalRef.current) {
                resolve()
              } else {
                requestAnimationFrame(check)
              }
            }
            check()
          })
        }

        setStatus('connected')
        await waitForRef()

        if (disposed || !terminalRef.current) return

        // Get theme from store
        const terminalTheme = useThemeStore.getState().getTerminalTheme()

        // Create terminal with dynamic theme and font settings
        const { fontSize, fontFamily } = useTerminalStore.getState()
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
        const serializeAddon = new SerializeAddon()
        term.loadAddon(serializeAddon)
        serializeScreen = () => serializeAddon.serialize({ scrollback: SNAPSHOT_SCROLLBACK_ROWS })

        term.open(terminalRef.current)
        attachTerminalWebLinks(term)
        // The tab's right-click menu acts on the shell that was clicked
        const unregister = registerTerminalPane(terminalRef.current, term)
        const logHighlight = attachLogHighlight(term)
        unregisterPane = () => {
          logHighlight.dispose()
          unregister()
        }
        disableCopyOnSelect = enableCopyOnSelect(term)
        detachCommandHistory = commandHistory.attach(term)
        terminalInstance.current = term
        isInitialized.current = true
        // Output that arrived before the pane could show it (login banner, first prompt).
        // Written in the same tick as isInitialized flips, so later chunks cannot overtake it.
        // The screen of the tab this shell came from first, in the pane's real size
        if (incoming?.screen) {
          try { fitAddon.current.fit() } catch { /* drawn in the default size */ }
          term.write(incoming.screen)
          markIncomingDrawn(sessionId, pane, '')
        }
        const earlyText = earlyOutput.take(streamIdRef.current ?? '')
        if (earlyText) term.write(earlyText)

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

        // Fit after a small delay and apply font settings
        setTimeout(() => {
          if (fitAddon.current && !disposed && terminalRef.current) {
            try {
              // Apply current font settings from store
              const currentSettings = useTerminalStore.getState()
              term!.options.fontSize = currentSettings.fontSize
              term!.options.fontFamily = `"${currentSettings.fontFamily}", Consolas, "D2Coding", monospace`

              fitAddon.current.fit()
              const dims = fitAddon.current.proposeDimensions()
              if (dims && streamIdRef.current) {
                window.electronAPI.sshSplitResize(streamIdRef.current, dims.cols, dims.rows)
              }

              // Signal terminal is ready
              setTerminalReady(true)
            } catch (e) {
              // Ignore
            }
          }
        }, 100)

        // Handle terminal input - send to split stream. The right button opens the app's menu: not
        // reported to the program too
        const withoutRightClick = createRightClickFilter()
        term.onData((raw) => {
          const data = withoutRightClick(raw)
          if (!data) return
          commandHistory.handleData(data)
          if (streamIdRef.current) {
            window.electronAPI.sshSplitSend(streamIdRef.current, data)
          }
        })

        // Handle resize
        // Same limits as the tab's main terminal: refit at most every REFIT_INTERVAL_MS while a divider
        // is dragged, and tell the server only when the size really changed
        let sentSize = ''
        refit = throttle(() => {
          if (fitAddon.current && isInitialized.current && !disposed) {
            try {
              fitAddon.current.fit()
              const dims = fitAddon.current.proposeDimensions()
              if (dims && streamIdRef.current && `${streamIdRef.current}:${dims.cols}x${dims.rows}` !== sentSize) {
                sentSize = `${streamIdRef.current}:${dims.cols}x${dims.rows}`
                window.electronAPI.sshSplitResize(streamIdRef.current, dims.cols, dims.rows)
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
        const handleFontSizeChange = async (e: Event) => {
          if (term && !disposed && fitAddon.current) {
            const customEvent = e as CustomEvent
            const newFontSize = customEvent.detail.fontSize
            term.options.fontSize = newFontSize
            // Refit terminal after font size change
            setTimeout(() => {
              try {
                fitAddon.current?.fit()
                const dims = fitAddon.current?.proposeDimensions()
                if (dims && streamIdRef.current) {
                  window.electronAPI.sshSplitResize(streamIdRef.current, dims.cols, dims.rows)
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
                fitAddon.current?.fit()
                const dims = fitAddon.current?.proposeDimensions()
                if (dims && streamIdRef.current) {
                  window.electronAPI.sshSplitResize(streamIdRef.current, dims.cols, dims.rows)
                }
              } catch (e) {
                // Ignore
              }
            }, 10)
          }
        }
        window.addEventListener('terminal-font-family-changed', handleFontFamilyChange)

        // Store cleanup function
        ;(terminalRef.current as any).__themeCleanup = () => {
          window.removeEventListener('theme-changed', handleThemeChange)
          window.removeEventListener('terminal-font-size-changed', handleFontSizeChange)
          window.removeEventListener('terminal-font-family-changed', handleFontFamilyChange)
        }
      } catch (err: any) {
        console.error('Split terminal init error:', err)
        // Auto-retry on exception
        if (autoRetryCount.current < MAX_AUTO_RETRIES && !disposed) {
          autoRetryCount.current++
          const retryDelay = BASE_RETRY_DELAY * Math.pow(2, autoRetryCount.current - 1)
          console.log(`Split terminal init error, auto-retry ${autoRetryCount.current}/${MAX_AUTO_RETRIES} in ${retryDelay}ms`)
          await new Promise<void>(resolve => {
            delayTimer = setTimeout(resolve, retryDelay)
          })
          if (!disposed) {
            return initTerminal()
          }
          return
        }
        setErrorMsg(err.message || '분할 터미널 초기화 실패')
        setStatus('error')
      }
    }

    // Listen for data from split stream. The main process forwards output as soon as the channel
    // opens, which can be before sshCreateShell resolves (our stream id unknown) or before the xterm
    // exists; those chunks are held instead of dropped.
    const handleSplitData = (data: { streamId: string; sessionId: string; data: string }) => {
      const ownStream = streamIdRef.current
      if (ownStream === null) {
        earlyOutput.push(data.streamId, data.data)
        return
      }
      if (data.streamId !== ownStream) return
      if (terminalInstance.current && isInitialized.current) {
        terminalInstance.current.write(data.data)
      } else {
        earlyOutput.push(data.streamId, data.data)
      }
    }

    // Listen for stream closed
    const handleSplitClosed = (data: { streamId: string; sessionId: string }) => {
      if (data.streamId === streamIdRef.current) {
        // A retry opens a shell of this tab's own
        forgetIncomingShell(sessionId, pane)
        streamIdRef.current = null
        setErrorMsg('분할 터미널 연결 종료')
        setStatus('error')
      }
    }

    const cleanupDataListener = window.electronAPI.onSshSplitData(handleSplitData)
    const cleanupClosedListener = window.electronAPI.onSshSplitClosed(handleSplitClosed)

    initTerminal()

    return () => {
      disposed = true
      isInitialized.current = false

      if (delayTimer) clearTimeout(delayTimer)
      unregisterShell()

      // Clean up IPC listeners
      if (cleanupDataListener) cleanupDataListener()
      if (cleanupClosedListener) cleanupClosedListener()

      // Close the split stream (not one that was given up: it lives on as a tab)
      if (isIncomingShell(sessionId, pane, streamIdRef.current)) {
        // Taken over from a tab: kept for a moment in case this pane mounts again (see incomingShells.ts)
        let screen = ''
        try { screen = serializeScreen ? serializeScreen() : '' } catch { screen = '' }
        // Torn down before the terminal existed: nothing was drawn, the held output goes back
        const unshown = term ? '' : earlyOutput.take(streamIdRef.current ?? '')
        releaseIncomingShell(sessionId, pane, screen, unshown)
        streamIdRef.current = null
      } else if (streamIdRef.current) {
        window.electronAPI.sshSplitClose(streamIdRef.current)
        streamIdRef.current = null
      }

      // Clean up theme listener
      if (terminalRef.current && (terminalRef.current as any).__themeCleanup) {
        (terminalRef.current as any).__themeCleanup()
      }

      if (resizeObserver) {
        resizeObserver.disconnect()
        refit?.cancel()
      }
      disableCopyOnSelect?.()
      unregisterPane?.()
      detachCommandHistory?.()
      if (term) {
        term.dispose()
      }
      terminalInstance.current = null
    }
  }, [sessionId, pane, retryCount])

  if (status === 'connecting') {
    return (
      <div className="split-terminal-content split-terminal-status">
        <span>분할 터미널 연결 중...</span>
      </div>
    )
  }

  if (status === 'error') {
    return (
      <div className="split-terminal-content split-terminal-status split-terminal-error">
        <span>{errorMsg}</span>
        <button
          className="split-terminal-retry-btn"
          onClick={() => {
            autoRetryCount.current = 0
            setRetryCount(c => c + 1)
          }}
        >
          재연결
        </button>
      </div>
    )
  }

  return (
    <>
      <div ref={terminalRef} className="split-terminal-content" />
      {commandHistory.popup}
    </>
  )
}
