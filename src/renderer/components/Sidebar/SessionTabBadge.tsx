import { useRef, useState } from 'react'
import * as DropdownMenu from '@radix-ui/react-dropdown-menu'
import { RiCheckLine } from 'react-icons/ri'
import { useTerminalStore } from '../../stores/terminalStore'
import { badgeHint, badgeLabel, type SessionTab, type TabStatus } from '../../lib/sessionTabs'
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
 * Count of open tabs for a sidebar session, boxed green (connected) or red (disconnected).
 * One tab: clicking goes straight to it. Several: clicking lists them to pick from.
 */
export function SessionTabBadge({ status, tabs }: SessionTabBadgeProps) {
  const activeTerminalId = useTerminalStore(state => state.activeTerminalId)
  const focusTerminal = useTerminalStore(state => state.focusTerminal)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const pickedRef = useRef(false)
  const [menuOffset, setMenuOffset] = useState(MENU_GAP)

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

  if (tabs.length === 1) {
    return (
      <button
        type="button"
        className={className}
        title={hint}
        aria-label={hint}
        onClick={() => focusTerminal(tabs[0].id)}
        onDoubleClick={stopRowGesture}
      >
        {tabs.length}
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
          onDoubleClick={stopRowGesture}
        >
          {tabs.length}
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
              <DropdownMenu.Item
                key={tab.id}
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
                {isCurrent && <RiCheckLine size={14} className="session-tab-menu-current" aria-label="현재 탭" />}
              </DropdownMenu.Item>
            )
          })}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  )
}
