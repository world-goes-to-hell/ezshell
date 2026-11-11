import type { ReactElement } from 'react'
import * as Tooltip from '@radix-ui/react-tooltip'
import { useSessionStore, type Session } from '../../stores/sessionStore'
import { useHistoryStore } from '../../stores/historyStore'
import { badgeLabel, type SessionTabGroup } from '../../lib/sessionTabs'
import { buildSessionDetails, formatAddress } from '../../lib/sessionTooltip'
import './SessionTooltip.css'

interface SessionTooltipProps {
  session: Session
  /** Tabs currently open from this session; absent when there are none */
  tabs?: SessionTabGroup
  /** Icon-only sidebar: the name is hidden, so the card opens sooner */
  compact: boolean
  children: ReactElement
}

/** The collapsed sidebar shows only icons, so the card is the only way to read the name */
const COMPACT_OPEN_DELAY_MS = 250
/** The expanded sidebar already shows the name; wait longer so moving across the list doesn't flash cards */
const EXPANDED_OPEN_DELAY_MS = 600

/**
 * Hover card with a session's connection details, for both sidebar widths.
 * Rendered in a portal so the scrolling session list cannot clip it.
 * Badge menus inside the row bubble events into this trigger: docs/brain/2026-10-01-react-events-bubble-through-portals-into-tooltip-trigger.md
 */
export function SessionTooltip({ session, tabs, compact, children }: SessionTooltipProps) {
  return (
    <Tooltip.Provider delayDuration={compact ? COMPACT_OPEN_DELAY_MS : EXPANDED_OPEN_DELAY_MS}>
      <Tooltip.Root>
        <Tooltip.Trigger asChild>{children}</Tooltip.Trigger>
        <Tooltip.Portal>
          <Tooltip.Content className="session-tooltip" side="right" sideOffset={10} collisionPadding={8}>
            <SessionTooltipBody session={session} tabs={tabs} />
          </Tooltip.Content>
        </Tooltip.Portal>
      </Tooltip.Root>
    </Tooltip.Provider>
  )
}

/** Mounted only while the card is open, so the details are computed on demand */
function SessionTooltipBody({ session, tabs }: { session: Session; tabs?: SessionTabGroup }) {
  const folders = useSessionStore(state => state.folders)
  const lastConnectedAt = useHistoryStore(
    state => state.recentConnections.find(r => r.sessionId === session.id)?.connectedAt
  )
  const details = buildSessionDetails(session, folders, lastConnectedAt, Date.now())
  const connectedCount = tabs?.connected.length ?? 0
  const disconnectedCount = tabs?.disconnected.length ?? 0
  const hasStatus = connectedCount > 0 || disconnectedCount > 0 || session.mcpEnabled === true

  return (
    <>
      <div className="session-tooltip-name">{session.name || session.host}</div>
      <div className="session-tooltip-address">{formatAddress(session.username, session.host, session.port)}</div>
      {details.length > 0 && (
        <dl className="session-tooltip-details">
          {details.map(d => (
            <div key={d.label} className="session-tooltip-row">
              <dt>{d.label}</dt>
              <dd>{d.value}</dd>
            </div>
          ))}
        </dl>
      )}
      {hasStatus && (
        <div className="session-tooltip-meta">
          {connectedCount > 0 && (
            <span className="session-tooltip-connected">{badgeLabel('connected', connectedCount)}</span>
          )}
          {disconnectedCount > 0 && (
            <span className="session-tooltip-disconnected">{badgeLabel('disconnected', disconnectedCount)}</span>
          )}
          {session.mcpEnabled === true && <span className="session-tooltip-mcp">MCP 접근 허용</span>}
        </div>
      )}
      <div className="session-tooltip-hint">더블클릭으로 연결</div>
    </>
  )
}
