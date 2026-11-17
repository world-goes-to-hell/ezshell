import { useCallback, useMemo, useRef, useState } from 'react'
import { RiAddLine, RiArrowDownSLine, RiArrowRightSLine, RiCloseLine, RiComputerLine } from 'react-icons/ri'
import { useTerminalStore } from '../../stores/terminalStore'
import { LOCAL_PANE_STORAGE_KEY, clampPaneHeight, parseLocalPanePrefs, visibleTerminalId, type LocalPanePrefs } from '../../lib/localTerminalPane'
import { isSplitTree, paneIds, type PaneId } from '../../lib/splitTree'
import { PaneLayoutBadge } from './PaneLayoutBadge'
import { tabHost } from '../../lib/tabHosts'
import './LocalTerminalList.css'

const KEY_STEP = 30

interface LocalTerminalListProps {
  onOpen?: () => void
  onClose: (terminalId: string) => void
}

function readPrefs(): LocalPanePrefs {
  try {
    return parseLocalPanePrefs(localStorage.getItem(LOCAL_PANE_STORAGE_KEY))
  } catch {
    return { collapsed: false }
  }
}

function writePrefs(prefs: LocalPanePrefs) {
  try {
    localStorage.setItem(LOCAL_PANE_STORAGE_KEY, JSON.stringify(prefs))
  } catch {
    // Not remembered this time; the pane still works
  }
}

/**
 * The open local terminals, below the session list. Rendered only while at least one is open.
 * Height: as tall as its rows up to half of the list area, until the user drags the divider.
 */
export function LocalTerminalList({ onOpen, onClose }: LocalTerminalListProps) {
  const terminals = useTerminalStore(state => state.terminals)
  const visibleId = useTerminalStore(state => visibleTerminalId(state.layout, state.activeTerminalId))
  const focusTerminal = useTerminalStore(state => state.focusTerminal)
  const [prefs, setPrefs] = useState<LocalPanePrefs>(readPrefs)
  const paneRef = useRef<HTMLDivElement>(null)
  // `height` is the latest dragged value: the pointer-up handler may still belong to the render before it
  const drag = useRef<{ startY: number; startHeight: number; height?: number } | null>(null)

  const locals = useMemo(
    () => Array.from(terminals.entries()).filter(([, terminal]) => terminal.local),
    [terminals]
  )

  const update = useCallback((next: LocalPanePrefs, persist: boolean) => {
    setPrefs(next)
    if (persist) writePrefs(next)
  }, [])

  // The list area both lists share (the pane's parent)
  const containerHeight = () => paneRef.current?.parentElement?.clientHeight ?? 0

  const handlePointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 || !paneRef.current) return
    event.preventDefault()
    event.currentTarget.setPointerCapture(event.pointerId)
    drag.current = { startY: event.clientY, startHeight: paneRef.current.getBoundingClientRect().height }
  }

  const handlePointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    if (!drag.current) return
    // Dragging up makes the pane taller
    const height = clampPaneHeight(drag.current.startHeight - (event.clientY - drag.current.startY), containerHeight())
    drag.current.height = height
    update({ collapsed: false, height }, false)
  }

  const handlePointerUp = (event: React.PointerEvent<HTMLDivElement>) => {
    if (!drag.current) return
    const { height } = drag.current
    drag.current = null
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId)
    // A press without movement is not a resize: the height stays automatic
    if (height !== undefined) writePrefs({ collapsed: false, height })
  }

  // Back to "as tall as the rows, up to half"
  const resetHeight = () => update({ collapsed: prefs.collapsed }, true)

  const handleKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return
    event.preventDefault()
    const current = paneRef.current?.getBoundingClientRect().height ?? 0
    const height = clampPaneHeight(current + (event.key === 'ArrowUp' ? KEY_STEP : -KEY_STEP), containerHeight())
    update({ collapsed: false, height }, true)
  }

  // A split tab shows how many sessions it holds; its layout map (PaneLayoutBadge) calls this to go to
  // the tab and put the keyboard in the picked pane. The pane is found in the tab's own DOM node
  // (lib/tabHosts.ts) by its data-pane attribute.
  const focusPane = (tabId: string, pane: PaneId) => {
    focusTerminal(tabId)
    window.setTimeout(() => {
      const element = tabHost(tabId).querySelector<HTMLElement>(`[data-pane="${CSS.escape(pane)}"] .xterm-helper-textarea`)
      element?.focus()
    }, 60)
  }

  // The pane of this tab that holds the keyboard now (null when the focus is elsewhere)
  const focusedPane = (tabId: string): PaneId | null => {
    const active = document.activeElement
    if (!active || !tabHost(tabId).contains(active)) return null
    return active.closest<HTMLElement>('[data-pane]')?.dataset.pane ?? null
  }

  if (locals.length === 0) return null

  const isSized = prefs.height !== undefined && !prefs.collapsed
  const CollapseIcon = prefs.collapsed ? RiArrowRightSLine : RiArrowDownSLine

  return (
    <div
      ref={paneRef}
      className={`local-terms ${isSized ? 'is-sized' : ''} ${prefs.collapsed ? 'is-collapsed' : ''}`}
      style={isSized ? { height: prefs.height } : undefined}
    >
      <div
        className="local-terms-divider"
        role="separator"
        aria-orientation="horizontal"
        aria-label="로컬 터미널 목록 높이"
        tabIndex={0}
        title="끌어서 높이 조절 · 두 번 누르면 자동 높이"
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={handlePointerUp}
        onDoubleClick={resetHeight}
        onKeyDown={handleKeyDown}
      />
      <div className="local-terms-header">
        <button
          type="button"
          className="local-terms-toggle"
          onClick={() => update({ ...prefs, collapsed: !prefs.collapsed }, true)}
          aria-expanded={!prefs.collapsed}
          title={prefs.collapsed ? '로컬 터미널 목록 펼치기' : '로컬 터미널 목록 접기'}
        >
          <CollapseIcon size={16} />
          <span>로컬 터미널</span>
          <span className="local-terms-count">{locals.length}</span>
        </button>
        {onOpen && (
          <button type="button" className="local-terms-btn" onClick={onOpen} title="새 로컬 터미널" aria-label="새 로컬 터미널">
            <RiAddLine size={16} />
          </button>
        )}
      </div>
      {!prefs.collapsed && (
        <ul className="local-terms-list">
          {locals.map(([id, terminal]) => {
            const name = terminal.title || '로컬 터미널'
            const panes = isSplitTree(terminal.splitTree) && terminal.splitTree ? paneIds(terminal.splitTree) : []
            return (
              <li key={id} className="local-terms-item">
              <div className={`local-terms-row ${id === visibleId ? 'is-current' : ''}`}>
                <button type="button" className="local-terms-open" onClick={() => focusTerminal(id)} title={`${name} 탭으로 이동`}>
                  <RiComputerLine size={15} className="local-terms-icon" />
                  <span className="local-terms-name">{name}</span>
                  <span className={`local-terms-dot ${terminal.connected ? 'is-on' : ''}`} aria-hidden="true" />
                </button>
                {panes.length > 1 && terminal.splitTree && (
                  <PaneLayoutBadge tabName={name} tree={terminal.splitTree} currentPane={() => focusedPane(id)} onPick={pane => focusPane(id, pane)} />
                )}
                <button type="button" className="local-terms-close" onClick={() => onClose(id)} title="닫기" aria-label={`${name} 닫기`}>
                  <RiCloseLine size={15} />
                </button>
              </div>
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}
