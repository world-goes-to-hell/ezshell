import type { ReactElement } from 'react'
import * as Tooltip from '@radix-ui/react-tooltip'
import { useSessionStore, type Session } from '../../stores/sessionStore'
import { badgeLabel, type SessionTabGroup } from '../../lib/sessionTabs'
import './SessionTooltip.css'

interface SessionTooltipProps {
  session: Session
  /** Tabs currently open from this session; absent when there are none */
  tabs?: SessionTabGroup
  /** Only the collapsed (icon-only) sidebar needs the tooltip */
  enabled: boolean
  children: ReactElement
}

const DEFAULT_SSH_PORT = 22
const OPEN_DELAY_MS = 250

/**
 * Hover card for a session in the collapsed sidebar, where only the icon is visible.
 * Rendered in a portal so the scrolling session list cannot clip it.
 */
export function SessionTooltip({ session, tabs, enabled, children }: SessionTooltipProps) {
  const folders = useSessionStore(state => state.folders)

  if (!enabled) return children

  const folderName = session.folderId ? folders.find(f => f.id === session.folderId)?.name : undefined
  const port = session.port || DEFAULT_SSH_PORT
  const connectedCount = tabs?.connected.length ?? 0
  const disconnectedCount = tabs?.disconnected.length ?? 0

  return (
    <Tooltip.Provider delayDuration={OPEN_DELAY_MS}>
      <Tooltip.Root>
        <Tooltip.Trigger asChild>{children}</Tooltip.Trigger>
        <Tooltip.Portal>
          <Tooltip.Content className="session-tooltip" side="right" sideOffset={10} collisionPadding={8}>
            <div className="session-tooltip-name">{session.name || session.host}</div>
            <div className="session-tooltip-address">
              {session.username}@{session.host}{port !== DEFAULT_SSH_PORT ? `:${port}` : ''}
            </div>
            {(folderName || tabs) && (
              <div className="session-tooltip-meta">
                {folderName && <span>폴더: {folderName}</span>}
                {connectedCount > 0 && (
                  <span className="session-tooltip-connected">{badgeLabel('connected', connectedCount)}</span>
                )}
                {disconnectedCount > 0 && (
                  <span className="session-tooltip-disconnected">{badgeLabel('disconnected', disconnectedCount)}</span>
                )}
              </div>
            )}
            <div className="session-tooltip-hint">더블클릭으로 연결</div>
          </Tooltip.Content>
        </Tooltip.Portal>
      </Tooltip.Root>
    </Tooltip.Provider>
  )
}
