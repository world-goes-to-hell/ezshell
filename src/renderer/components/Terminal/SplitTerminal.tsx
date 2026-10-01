import { useEffect, useRef, useState } from 'react'
import { Terminal } from 'xterm'
import { FitAddon } from 'xterm-addon-fit'
import { useThemeStore } from '../../stores/themeStore'
import { useTerminalStore } from '../../stores/terminalStore'
import { copyToClipboard, enableCopyOnSelect, isPasteShortcut } from '../../lib/terminalClipboard'
import { useTerminalCommandHistory } from '../../hooks/useTerminalCommandHistory'
import 'xterm/css/xterm.css'
import { createEarlyStreamBuffer } from '../../lib/earlyStreamBuffer'

interface SplitTerminalProps {
  sessionId: string
  delay?: number
}

const MAX_AUTO_RETRIES = 3
const BASE_RETRY_DELAY = 1000 // 1 second

export function SplitTerminal({ sessionId, delay = 0 }: SplitTerminalProps) {
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
    let detachCommandHistory: (() => void) | null = null
    let resizeObserver: ResizeObserver | null = null
    let disposed = false
    let delayTimer: ReturnType<typeof setTimeout> | null = null
    // Split output that arrives before this pane can show it (see handleSplitData)
    const earlyOutput = createEarlyStreamBuffer()

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
        const result = await window.electronAPI.sshCreateShell(sessionId)
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
          if (result.streamId) window.electronAPI.sshSplitClose(result.streamId)
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

        term.open(terminalRef.current)
        disableCopyOnSelect = enableCopyOnSelect(term)
        detachCommandHistory = commandHistory.attach(term)
        terminalInstance.current = term
        isInitialized.current = true
        // Output that arrived before the pane could show it (login banner, first prompt).
        // Written in the same tick as isInitialized flips, so later chunks cannot overtake it.
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

        // Handle terminal input - send to split stream
        term.onData((data) => {
          commandHistory.handleData(data)
          if (streamIdRef.current) {
            window.electronAPI.sshSplitSend(streamIdRef.current, data)
          }
        })

        // Handle resize
        resizeObserver = new ResizeObserver(() => {
          if (fitAddon.current && isInitialized.current && !disposed) {
            try {
              fitAddon.current.fit()
              const dims = fitAddon.current.proposeDimensions()
              if (dims && streamIdRef.current) {
                window.electronAPI.sshSplitResize(streamIdRef.current, dims.cols, dims.rows)
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

      // Clean up IPC listeners
      if (cleanupDataListener) cleanupDataListener()
      if (cleanupClosedListener) cleanupClosedListener()

      // Close the split stream
      if (streamIdRef.current) {
        window.electronAPI.sshSplitClose(streamIdRef.current)
        streamIdRef.current = null
      }

      // Clean up theme listener
      if (terminalRef.current && (terminalRef.current as any).__themeCleanup) {
        (terminalRef.current as any).__themeCleanup()
      }

      if (resizeObserver) {
        resizeObserver.disconnect()
      }
      disableCopyOnSelect?.()
      detachCommandHistory?.()
      if (term) {
        term.dispose()
      }
      terminalInstance.current = null
    }
  }, [sessionId, retryCount])

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
