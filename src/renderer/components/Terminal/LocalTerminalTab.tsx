import { useEffect, useMemo, useRef, useState, type CSSProperties, type MouseEvent } from 'react'
import { throttle, REFIT_INTERVAL_MS } from '../../lib/throttle'
import { Terminal } from 'xterm'
import { FitAddon } from 'xterm-addon-fit'
import 'xterm/css/xterm.css'
import { RiToolsLine, RiLayoutColumnLine, RiSplitCellsHorizontal, RiSplitCellsVertical, RiLayoutGridLine, RiCloseLine } from 'react-icons/ri'
import { useThemeStore } from '../../stores/themeStore'
import { useTerminalStore } from '../../stores/terminalStore'
import { copyToClipboard, enableCopyOnSelect, isPasteShortcut } from '../../lib/terminalClipboard'
import { MAIN_PANE, MAX_PANES, singlePane, layoutOf, leafCount, paneIds, closePane, equalize, paneBox, type PaneId } from '../../lib/splitTree'
import { ensureLocalPaneShell, closeLocalPaneShells } from '../../lib/localPaneShells'
import { TerminalContextMenu, MENU_SEPARATOR, type TerminalMenuGroup } from './TerminalContextMenu'
import { commonTerminalItems } from './terminalMenuCommon'
import { attachLogHighlight } from './terminalLogHighlight'
import { SplitChrome, PANE_DIVIDER_PX } from './SplitChrome'
import './LocalTerminalTab.css'

interface LocalTerminalTabProps {
  /** The tab's id, which is also the id of its first shell in the main process */
  terminalId: string
  isActive: boolean
  onActivate: () => void
}

const fontStack = (family: string): string => `"${family}", Consolas, "D2Coding", monospace`
/** A pane is not split when a half would be smaller than this (columns / rows of text) */
const MIN_PANE_COLS = 20
const MIN_PANE_ROWS = 5
const refit = () => requestAnimationFrame(() => window.dispatchEvent(new Event('resize')))

interface LocalShellViewProps {
  tabId: string
  pane: PaneId
  /** The shell in the main process this pane shows */
  shellId: string
  /** The tab is in front and this is its first pane: it takes the keyboard */
  takesFocus: boolean
  style?: CSSProperties
}

/**
 * One shell of this PC (src/localShell.js) drawn in a pane. The shell outlives the element: drawn
 * again (tab moved, layout changed) it asks for the output so far and continues.
 */
function LocalShellView({ tabId, pane, shellId, takesFocus, style }: LocalShellViewProps) {
  const hostRef = useRef<HTMLDivElement>(null)
  const terminalRef = useRef<Terminal | null>(null)
  const fitRef = useRef<FitAddon | null>(null)
  const [exit, setExit] = useState<{ code: number | null } | null>(null)
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null)
  const fontSize = useTerminalStore(state => state.fontSize)
  const fontFamily = useTerminalStore(state => state.fontFamily)
  const tab = useTerminalStore(state => state.terminals.get(tabId))
  const splitTerminalPane = useTerminalStore(state => state.splitTerminalPane)
  const setSplitTree = useTerminalStore(state => state.setSplitTree)
  const tabName = tab?.title ?? '로컬 터미널'

  const fit = (): void => {
    const terminal = terminalRef.current
    const addon = fitRef.current
    if (!terminal || !addon) return
    try {
      addon.fit()
      window.electronAPI.localShellResize?.(shellId, terminal.cols, terminal.rows)
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
    const logHighlight = attachLogHighlight(terminal)

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
    terminal.onData(data => window.electronAPI.localShellWrite?.(shellId, data))

    // Output sent before the answer to `attach` is already part of that answer, so it is not drawn twice
    let isAttached = false
    let isDisposed = false
    const stopData = window.electronAPI.onLocalShellData?.(({ id, data }) => {
      if (id === shellId && isAttached) terminal.write(data)
    })
    const stopExit = window.electronAPI.onLocalShellExit?.(({ id, exitCode }) => {
      if (id === shellId) setExit({ code: exitCode })
    })
    void window.electronAPI.localShellAttach?.(shellId).then((state) => {
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
    // A reflow per frame while a divider is dragged made resizing stutter: refit at intervals
    const refit = throttle(() => { if (!isDisposed) fit() }, REFIT_INTERVAL_MS)
    const observer = new ResizeObserver(() => refit())
    observer.observe(host)

    return () => {
      isDisposed = true
      stopData?.()
      stopExit?.()
      window.removeEventListener('theme-changed', onTheme)
      observer.disconnect()
      refit.cancel()
      disableCopyOnSelect()
      logHighlight.dispose()
      terminal.dispose()
      terminalRef.current = null
      fitRef.current = null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shellId])

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
    if (!takesFocus) return
    const timer = window.setTimeout(() => {
      fit()
      terminalRef.current?.focus()
    }, 30)
    return () => window.clearTimeout(timer)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [takesFocus])

  const onContextMenu = (event: MouseEvent): void => {
    event.preventDefault()
    setMenu({ x: event.clientX, y: event.clientY })
  }

  const terminal = terminalRef.current
  let groups: TerminalMenuGroup[] | null = null
  let top: ReturnType<typeof commonTerminalItems>['top'] | null = null
  if (menu && terminal) {
    const then = (action: () => void) => () => {
      action()
      window.setTimeout(() => terminal.focus(), 0)
    }
    const items = commonTerminalItems(terminal, tabName, then)
    top = items.top
    const tree = tab?.splitTree ?? singlePane()
    const isSplit = tab?.isSplit === true
    const isFull = leafCount(tree) >= MAX_PANES
    const isTooNarrow = Math.floor(terminal.cols / 2) < MIN_PANE_COLS
    const isTooShort = Math.floor(terminal.rows / 2) < MIN_PANE_ROWS
    groups = [
      {
        label: '분할',
        icon: RiLayoutColumnLine,
        items: [
          // Divides the pane that was clicked only: a new shell of this PC opens to its right or below it
          {
            label: isFull ? `좌우 분할 (칸은 ${MAX_PANES}개까지)` : isTooNarrow ? '좌우 분할 (칸이 좁습니다)' : '좌우 분할',
            icon: RiSplitCellsHorizontal,
            disabled: isFull || isTooNarrow,
            onSelect: then(() => splitTerminalPane(tabId, pane, 'row'))
          },
          {
            label: isFull ? `상하 분할 (칸은 ${MAX_PANES}개까지)` : isTooShort ? '상하 분할 (칸이 낮습니다)' : '상하 분할',
            icon: RiSplitCellsVertical,
            disabled: isFull || isTooShort,
            onSelect: then(() => splitTerminalPane(tabId, pane, 'col'))
          },
          MENU_SEPARATOR,
          { label: '칸 크기 균등화', icon: RiLayoutGridLine, disabled: !isSplit, onSelect: then(() => { setSplitTree(tabId, equalize(tree)); refit() }) },
          {
            label: pane === MAIN_PANE && isSplit ? '이 칸 닫기 (탭의 첫 터미널)' : '이 칸 닫기',
            icon: RiCloseLine,
            disabled: !isSplit || pane === MAIN_PANE,
            onSelect: () => { setSplitTree(tabId, closePane(tree, pane)); refit() }
          }
        ]
      },
      { label: '편의', icon: RiToolsLine, items: items.output }
    ]
  }

  return (
    <div className="local-terminal-pane" data-pane={pane} style={style}>
      <div ref={hostRef} className="local-terminal-host" onContextMenu={onContextMenu} />
      {exit && (
        <div className="local-terminal-exit" role="status">
          셸이 종료되었습니다{exit.code !== null && exit.code !== 0 ? ` (종료 코드 ${exit.code})` : ''}.
          {pane === MAIN_PANE ? ' 탭을 닫아 주세요.' : ' 우클릭 메뉴의 `분할` > `이 칸 닫기` 로 닫아 주세요.'}
        </div>
      )}
      {menu && groups && top && (
        <TerminalContextMenu
          key={`${menu.x}:${menu.y}`}
          position={menu}
          top={top}
          groups={groups}
          onClose={() => setMenu(null)}
        />
      )}
    </div>
  )
}

/** A split pane of a local terminal tab: opens a shell of its own, then shows it */
function LocalSplitPane({ tabId, pane, style }: { tabId: string; pane: PaneId; style: CSSProperties }) {
  const [shell, setShell] = useState<{ id: string } | { error: string } | null>(null)
  const [attempt, setAttempt] = useState(0)

  useEffect(() => {
    let isCurrent = true
    setShell(null)
    void ensureLocalPaneShell(tabId, pane).then((result) => {
      if (isCurrent) setShell(result.ok ? { id: result.id } : { error: result.error })
    })
    return () => { isCurrent = false }
  }, [tabId, pane, attempt])

  if (shell && 'id' in shell) return <LocalShellView tabId={tabId} pane={pane} shellId={shell.id} takesFocus={false} style={style} />
  return (
    <div className="local-terminal-pane local-terminal-pane-status" data-pane={pane} style={style} role="status">
      {shell ? (
        <>
          <span>{shell.error}</span>
          <button type="button" className="split-terminal-retry-btn" onClick={() => setAttempt(count => count + 1)}>다시 시도</button>
        </>
      ) : <span>로컬 셸 여는 중...</span>}
    </div>
  )
}

/**
 * A terminal of this PC shown as a tab. Like an SSH tab it can be divided into panes
 * (lib/splitTree.ts); the first pane is the tab's own shell, every other pane has a shell of its own.
 */
export function LocalTerminalTab({ terminalId, isActive, onActivate }: LocalTerminalTabProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const splitTree = useTerminalStore(state => state.terminals.get(terminalId)?.splitTree)
  const isSplit = !!splitTree
  const layout = useMemo(() => layoutOf(splitTree ?? singlePane()), [splitTree])
  const mainRect = layout.panes.find(entry => entry.pane === MAIN_PANE)?.rect
  // In a fixed order (by id), whatever their places: swapping panes changes boxes, not elements
  const splitPanes = isSplit
    ? layout.panes.filter(entry => entry.pane !== MAIN_PANE).sort((a, b) => a.pane.localeCompare(b.pane, undefined, { numeric: true }))
    : []

  // A pane that left the split (closed, or the split ended) takes its shell with it
  useEffect(() => {
    closeLocalPaneShells(terminalId, splitTree ? paneIds(splitTree) : [])
  }, [terminalId, splitTree])

  return (
    <div ref={containerRef} className={`local-terminal-tab${isSplit ? ' is-split' : ''}`} onMouseDown={onActivate}>
      <LocalShellView
        tabId={terminalId}
        pane={MAIN_PANE}
        shellId={terminalId}
        takesFocus={isActive}
        style={isSplit && mainRect ? paneBox(mainRect, PANE_DIVIDER_PX) : undefined}
      />
      {splitPanes.map(({ pane, rect }) => (
        <LocalSplitPane key={`w-${pane}`} tabId={terminalId} pane={pane} style={paneBox(rect, PANE_DIVIDER_PX)} />
      ))}
      {isSplit && splitTree && <SplitChrome tabId={terminalId} tree={splitTree} containerRef={containerRef} />}
    </div>
  )
}

export default LocalTerminalTab
