import { useEffect, useRef, useState, type MouseEvent } from 'react'
import { Terminal } from 'xterm'
import { FitAddon } from 'xterm-addon-fit'
import 'xterm/css/xterm.css'
import { RiToolsLine } from 'react-icons/ri'
import { useThemeStore } from '../../stores/themeStore'
import { useTerminalStore } from '../../stores/terminalStore'
import { copyToClipboard, enableCopyOnSelect, isPasteShortcut } from '../../lib/terminalClipboard'
import { TerminalContextMenu } from './TerminalContextMenu'
import { commonTerminalItems } from './terminalMenuCommon'
import './LocalTerminalTab.css'

interface LocalTerminalTabProps {
  /** The tab's id, which is also the shell's id in the main process */
  terminalId: string
  isActive: boolean
  onActivate: () => void
}

const fontStack = (family: string): string => `"${family}", Consolas, "D2Coding", monospace`

/**
 * A terminal of this PC shown as a tab (the shell runs in the main process, src/localShell.js).
 * The shell outlives this component: when the tab is drawn again (pane split, tab moved) it asks
 * for the output so far and continues.
 */
export function LocalTerminalTab({ terminalId, isActive, onActivate }: LocalTerminalTabProps) {
  const hostRef = useRef<HTMLDivElement>(null)
  const terminalRef = useRef<Terminal | null>(null)
  const fitRef = useRef<FitAddon | null>(null)
  const [exit, setExit] = useState<{ code: number | null } | null>(null)
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null)
  const fontSize = useTerminalStore(state => state.fontSize)
  const fontFamily = useTerminalStore(state => state.fontFamily)
  const tabName = useTerminalStore(state => state.terminals.get(terminalId)?.title) ?? '로컬 터미널'

  const fit = (): void => {
    const terminal = terminalRef.current
    const addon = fitRef.current
    if (!terminal || !addon) return
    try {
      addon.fit()
      window.electronAPI.localShellResize?.(terminalId, terminal.cols, terminal.rows)
    } catch {
      // The element has no size yet (hidden tab)
    }
  }

  useEffect(() => {
    const host = hostRef.current
    if (!host) return
    const { fontSize: size, fontFamily: family } = useTerminalStore.getState()
    const terminal = new Terminal({
      theme: useThemeStore.getState().getTerminalTheme(),
      fontSize: size,
      fontFamily: fontStack(family),
      cursorBlink: true,
      cursorStyle: 'bar',
      cursorInactiveStyle: 'bar',
      scrollback: 10000,
      allowProposedApi: true
    })
    const addon = new FitAddon()
    terminal.loadAddon(addon)
    terminal.open(host)
    terminalRef.current = terminal
    fitRef.current = addon
    const disableCopyOnSelect = enableCopyOnSelect(terminal)

    terminal.attachCustomKeyEventHandler((event) => {
      // Ctrl+C with a selection copies instead of interrupting
      if (event.ctrlKey && event.key === 'c' && event.type === 'keydown') {
        const selection = terminal.getSelection()
        if (selection) {
          void copyToClipboard(selection)
          return false
        }
      }
      // Ctrl+V = paste, done by xterm from the native paste event
      if (isPasteShortcut(event)) return false
      return true
    })
    terminal.onData(data => window.electronAPI.localShellWrite?.(terminalId, data))

    // Output sent before the answer to `attach` is already part of that answer, so it is not drawn twice
    let isAttached = false
    let isDisposed = false
    const stopData = window.electronAPI.onLocalShellData?.(({ id, data }) => {
      if (id === terminalId && isAttached) terminal.write(data)
    })
    const stopExit = window.electronAPI.onLocalShellExit?.(({ id, exitCode }) => {
      if (id === terminalId) setExit({ code: exitCode })
    })
    void window.electronAPI.localShellAttach?.(terminalId).then((state) => {
      if (isDisposed) return
      isAttached = true
      if (!state) {
        setExit({ code: null })
        return
      }
      if (state.backlog) terminal.write(state.backlog)
      if (state.exited) setExit({ code: state.exitCode })
    })

    const onTheme = (): void => { terminal.options.theme = useThemeStore.getState().getTerminalTheme() }
    window.addEventListener('theme-changed', onTheme)
    const observer = new ResizeObserver(() => fit())
    observer.observe(host)

    return () => {
      isDisposed = true
      stopData?.()
      stopExit?.()
      window.removeEventListener('theme-changed', onTheme)
      observer.disconnect()
      disableCopyOnSelect()
      terminal.dispose()
      terminalRef.current = null
      fitRef.current = null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [terminalId])

  useEffect(() => {
    const terminal = terminalRef.current
    if (!terminal) return
    terminal.options.fontSize = fontSize
    terminal.options.fontFamily = fontStack(fontFamily)
    const timer = window.setTimeout(fit, 10)
    return () => window.clearTimeout(timer)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fontSize, fontFamily])

  useEffect(() => {
    if (!isActive) return
    const timer = window.setTimeout(() => {
      fit()
      terminalRef.current?.focus()
    }, 30)
    return () => window.clearTimeout(timer)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isActive])

  const onContextMenu = (event: MouseEvent): void => {
    event.preventDefault()
    setMenu({ x: event.clientX, y: event.clientY })
  }

  const terminal = terminalRef.current
  const items = menu && terminal
    ? commonTerminalItems(terminal, tabName, (action) => () => {
      action()
      window.setTimeout(() => terminal.focus(), 0)
    })
    : null

  return (
    <div className="local-terminal-tab" onMouseDown={onActivate}>
      <div ref={hostRef} className="local-terminal-host" onContextMenu={onContextMenu} />
      {exit && (
        <div className="local-terminal-exit" role="status">
          셸이 종료되었습니다{exit.code !== null && exit.code !== 0 ? ` (종료 코드 ${exit.code})` : ''}. 탭을 닫아 주세요.
        </div>
      )}
      {menu && items && (
        <TerminalContextMenu
          key={`${menu.x}:${menu.y}`}
          position={menu}
          top={items.top}
          groups={[{ label: '편의', icon: RiToolsLine, items: items.output }]}
          onClose={() => setMenu(null)}
        />
      )}
    </div>
  )
}

export default LocalTerminalTab
