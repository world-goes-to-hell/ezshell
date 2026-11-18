import { useRef, useState } from 'react'
import * as DropdownMenu from '@radix-ui/react-dropdown-menu'
import { RiCheckLine } from 'react-icons/ri'
import { useTerminalStore } from '../../stores/terminalStore'
import { badgeHint, badgeLabel, type SessionTab, type TabStatus } from '../../lib/sessionTabs'
import { layoutOf, type PaneId } from '../../lib/splitTree'
import { cellStyle, focusTabPane, focusedPaneOf } from '../../lib/paneFocus'
import './PaneMap.css'
import './SessionTabBadge.css'

interface SessionTabBadgeProps {
  status: TabStatus
  tabs: SessionTab[]
}

/**
 * The session row connects on double click and opens its own menu on right click; neither may come from
 * the badge. Clicks are left to bubble: in the icon-only sidebar the row's hover card closes on click, and
 * swallowing it lets a pending hover card open on top of the tab list.
 */
const stopRowGesture = (e: React.SyntheticEvent) => e.stopPropagation()

/** Space between the sidebar's edge and the tab list */
const MENU_GAP = 6

/**
 * A split tab's layout under its row in the list: each pane is a menu item, so the arrow keys reach it
 * and picking it goes to that tab with the keyboard in that pane (as the local terminal list's map does).
 */
function TabPaneMap({ tab, current, onPick }: { tab: SessionTab; current: PaneId | null; onPick: (pane: PaneId) => void }) {
  if (!tab.splitTree) return null
  const layout = layoutOf(tab.splitTree)
  return (
    <DropdownMenu.Group className="session-tab-map" aria-label={`${tab.label} 의 분할 배치 (${layout.panes.length}세션)`}>
      <div className="pane-map-area session-tab-map-area">
        {layout.vacants.map(({ pane, rect }) => (
          <div key={`vacant-${pane}`} className="pane-map-cell is-vacant" style={cellStyle(rect)} aria-hidden="true" />
        ))}
        {layout.panes.map(({ pane, rect }, index) => (
          <DropdownMenu.Item key={pane} asChild onSelect={() => onPick(pane)}>
            <button
              type="button"
              className={`pane-map-cell ${pane === current ? 'is-current' : ''}`}
              style={cellStyle(rect)}
              aria-label={`${tab.label} 의 세션 ${index + 1}로 이동${pane === current ? ' (지금 입력 중)' : ''}`}
            >
              <span>{index + 1}</span>
            </button>
          </DropdownMenu.Item>
        ))}
      </div>
    </DropdownMenu.Group>
  )
}

/**
 * Count of open tabs for a sidebar session, boxed green (connected) or red (disconnected).
 * One tab that is not split: clicking goes straight to it. Otherwise clicking lists the tabs to pick
 * from, with a map of each split tab whose panes can be picked.
 */
export function SessionTabBadge({ status, tabs }: SessionTabBadgeProps) {
  const activeTerminalId = useTerminalStore(state => state.activeTerminalId)
  const focusTerminal = useTerminalStore(state => state.focusTerminal)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const pickedRef = useRef(false)
  const [menuOffset, setMenuOffset] = useState(MENU_GAP)
  // Which pane of each tab had the keyboard, read when the badge is pressed (opening the list moves the focus)
  const [currentPanes, setCurrentPanes] = useState<ReadonlyMap<string, PaneId | null>>(new Map())
  const rememberPanes = () => setCurrentPanes(new Map(tabs.map(tab => [tab.id, focusedPaneOf(tab.id)])))

  const handleMenuOpenChange = (open: boolean) => {
    const trigger = triggerRef.current
    if (open) {
      // Open past the sidebar's edge so the list never covers the session rows; in the icon-only sidebar
      // the connected badge sits on the tile's left corner
      const sidebar = trigger?.closest('.sidebar')
      if (trigger && sidebar) {
        const pastSidebar = sidebar.getBoundingClientRect().right - trigger.getBoundingClientRect().right
        setMenuOffset(Math.max(0, pastSidebar) + MENU_GAP)
      }
      return
    }
    // The tab list is a portal: to React the pointer is still inside the session row while it moves over the
    // list, so the row never sees it leave and its hover card (icon-only sidebar) skips the next hover.
    // Report the leave once the list closes.
    trigger?.closest('.session-item')?.dispatchEvent(
      new PointerEvent('pointerout', { bubbles: true, relatedTarget: document.body })
    )
  }

  if (tabs.length === 0) return null

  const hint = badgeHint(status, tabs.length)
  const className = `session-tab-badge session-tab-badge--${status}`
  const count = <><span className="session-tab-badge-dot" aria-hidden="true" />{tabs.length}</>

  if (tabs.length === 1 && !tabs[0].splitTree) {
    return (
      <button
        type="button"
        className={className}
        title={hint}
        aria-label={hint}
        onClick={() => focusTerminal(tabs[0].id)}
        onDoubleClick={stopRowGesture}
      >
        {count}
      </button>
    )
  }

  return (
    <DropdownMenu.Root onOpenChange={handleMenuOpenChange}>
      <DropdownMenu.Trigger asChild>
        <button
          ref={triggerRef}
          type="button"
          className={className}
          title={hint}
          aria-label={hint}
          onPointerDown={rememberPanes}
          onDoubleClick={stopRowGesture}
        >
          {count}
        </button>
      </DropdownMenu.Trigger>

      <DropdownMenu.Portal>
        <DropdownMenu.Content
          className="session-tab-menu"
          side="right"
          align="start"
          sideOffset={menuOffset}
          collisionPadding={8}
          // React events bubble through the portal to the session row
          onDoubleClick={stopRowGesture}
          onContextMenu={stopRowGesture}
          // After a pick the terminal has keyboard focus; only a dismissed list hands it back to the badge
          onCloseAutoFocus={(e) => {
            if (pickedRef.current) e.preventDefault()
            pickedRef.current = false
          }}
        >
          <DropdownMenu.Label className={`session-tab-menu-label session-tab-menu-label--${status}`}>
            {badgeLabel(status, tabs.length)}
          </DropdownMenu.Label>
          {tabs.map(tab => {
            const isCurrent = tab.id === activeTerminalId
            return (
              <div key={tab.id} className="session-tab-menu-entry">
              <DropdownMenu.Item
                className="session-tab-menu-item"
                aria-current={isCurrent ? 'true' : undefined}
                onSelect={() => {
                  pickedRef.current = true
                  focusTerminal(tab.id)
                }}
              >
                <span className="session-tab-menu-index">{tab.index}</span>
                <div className="session-tab-menu-text">
                  <span className="session-tab-menu-title">{tab.label}</span>
                  {tab.path && <span className="session-tab-menu-path">{tab.path}</span>}
                </div>
                {tab.splitTree && <span className="session-tab-menu-panes">{layoutOf(tab.splitTree).panes.length}세션</span>}
                {isCurrent && <RiCheckLine size={14} className="session-tab-menu-current" aria-label="현재 탭" />}
              </DropdownMenu.Item>
              <TabPaneMap
                tab={tab}
                current={currentPanes.get(tab.id) ?? null}
                onPick={pane => {
                  pickedRef.current = true
                  focusTabPane(focusTerminal, tab.id, pane)
                }}
              />
              </div>
            )
          })}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  )
}
