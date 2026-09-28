import type { ReactElement } from 'react'
import * as Tooltip from '@radix-ui/react-tooltip'
import { useSessionStore, type Session } from '../../stores/sessionStore'
import { TagBadge } from '../common/TagBadge'
import './SessionTooltip.css'

interface SessionTooltipProps {
  session: Session
  isActive: boolean
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
export function SessionTooltip({ session, isActive, enabled, children }: SessionTooltipProps) {
  const folders = useSessionStore(state => state.folders)
  const availableTags = useSessionStore(state => state.availableTags)

  if (!enabled) return children

  const folderName = session.folderId ? folders.find(f => f.id === session.folderId)?.name : undefined
  const port = session.port || DEFAULT_SSH_PORT
  const tags = (session.tags ?? [])
    .map(tagId => availableTags.find(t => t.id === tagId))
    .filter((tag): tag is NonNullable<typeof tag> => Boolean(tag))

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
            {(folderName || isActive) && (
              <div className="session-tooltip-meta">
                {folderName && <span>폴더: {folderName}</span>}
                {isActive && <span className="session-tooltip-connected">연결됨</span>}
              </div>
            )}
            {tags.length > 0 && (
              <div className="session-tooltip-tags">
                {tags.map(tag => <TagBadge key={tag.id} name={tag.name} color={tag.color} size="sm" />)}
              </div>
            )}
            <div className="session-tooltip-hint">더블클릭으로 연결</div>
          </Tooltip.Content>
        </Tooltip.Portal>
      </Tooltip.Root>
    </Tooltip.Provider>
  )
}
