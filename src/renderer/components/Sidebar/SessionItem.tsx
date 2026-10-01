import { motion } from 'framer-motion'
import { RiServerFill, RiDatabase2Fill, RiCloudFill, RiGlobalFill, RiHomeFill, RiComputerFill, RiHardDriveFill, RiCpuFill, RiBaseStationFill } from 'react-icons/ri'
import type { Session } from '../../stores/sessionStore'
import { SessionIcon } from '../Modal/ConnectModal'
import { SessionTooltip } from './SessionTooltip'
import { SessionTabBadge } from './SessionTabBadge'
import type { DropPosition } from '../../lib/sessionOrder'
import type { SessionTabGroup } from '../../lib/sessionTabs'
import { getAbbreviation } from '../../lib/sessionAbbreviation'

const ICON_MAP: Record<SessionIcon, typeof RiServerFill> = {
  'server': RiServerFill,
  'database': RiDatabase2Fill,
  'cloud': RiCloudFill,
  'globe': RiGlobalFill,
  'home': RiHomeFill,
  'monitor': RiComputerFill,
  'hard-drive': RiHardDriveFill,
  'cpu': RiCpuFill,
  'radio': RiBaseStationFill,
}

interface SessionItemProps {
  session: Session
  onConnect: (session: Session) => void
  onContextMenu: (e: React.MouseEvent, sessionId: string) => void
  onDragStart: (e: React.DragEvent, type: 'session' | 'folder', id: string) => void
  onDragEnd: () => void
  /** Reordering: another session dragged over / dropped on this one */
  onItemDragOver: (e: React.DragEvent, sessionId: string) => void
  onItemDragLeave: (e: React.DragEvent, sessionId: string) => void
  onItemDrop: (e: React.DragEvent, sessionId: string) => void
  /** Where a dropped session would land relative to this one, shown as a line */
  dropIndicator?: DropPosition | null
  isDragging: boolean
  isCompact: boolean
  reducedMotion: boolean
  /** Tabs currently open from this session; absent when there are none */
  tabs?: SessionTabGroup
  effectiveColor?: string
}

const DEFAULT_ICON: SessionIcon = 'server'

/** Session and folder colors go through a CSS variable in the icon-only sidebar so hover rules still apply */
type ColorStyle = React.CSSProperties & { '--session-color'?: string }

function getItemStyle(color: string | undefined, isActive: boolean, isCompact: boolean): ColorStyle | undefined {
  if (!color) return undefined
  if (isCompact) return { '--session-color': color }
  return {
    borderLeft: `3px solid ${color}`,
    background: `${color}${isActive ? '30' : '20'}`
  }
}

export function SessionItem({
  session, onConnect, onContextMenu, onDragStart, onDragEnd, onItemDragOver, onItemDragLeave, onItemDrop,
  dropIndicator, isDragging, isCompact, reducedMotion, tabs, effectiveColor
}: SessionItemProps) {
  const isActive = (tabs?.connected.length ?? 0) > 0
  const tabBadges = tabs && (
    // Focus moving to a badge or into its tab list (a portal, still a React child) must not reach the row:
    // the icon-only sidebar would open the session hover card on top of the list
    <div className="session-tab-badges" onFocus={(e) => e.stopPropagation()}>
      <SessionTabBadge status="connected" tabs={tabs.connected} />
      <SessionTabBadge status="disconnected" tabs={tabs.disconnected} />
    </div>
  )
  const iconId = (session.icon as SessionIcon) || DEFAULT_ICON
  const IconComponent = ICON_MAP[iconId] || RiServerFill
  const displayName = session.name || session.host
  // Every session shares the default icon, so the icon-only sidebar shows a short label instead
  const showAbbreviation = isCompact && iconId === DEFAULT_ICON

  const classNames = [
    'session-item',
    isDragging && 'dragging',
    isActive && 'active',
    isActive && effectiveColor && 'active-custom-color',
    effectiveColor && 'has-color',
    dropIndicator && `drop-${dropIndicator}`
  ].filter(Boolean).join(' ')

  return (
    <SessionTooltip session={session} tabs={tabs} enabled={isCompact}>
      <motion.div
        className={classNames}
        role="treeitem"
        aria-label={`SSH session: ${displayName}`}
        aria-selected={isActive}
        tabIndex={0}
        onDoubleClick={() => onConnect(session)}
        onContextMenu={(e) => onContextMenu(e, session.id)}
        draggable
        // motion.div treats onDragStart/onDragEnd as its own gesture props
        // and never forwards them to the DOM, so use the capture variants
        onDragStartCapture={(e) => onDragStart(e, 'session', session.id)}
        onDragEndCapture={onDragEnd}
        onDragOver={(e) => onItemDragOver(e, session.id)}
        onDragLeave={(e) => onItemDragLeave(e, session.id)}
        onDrop={(e) => onItemDrop(e, session.id)}
        // Sliding sideways would push the icon-only column into horizontal overflow
        whileHover={reducedMotion || isCompact ? undefined : { x: 4 }}
        transition={{ duration: 0.15 }}
        style={getItemStyle(effectiveColor, isActive, isCompact)}
      >
        <div className="session-item-icon">
          {showAbbreviation
            ? <span className="session-abbr" aria-hidden="true">{getAbbreviation(displayName)}</span>
            : <IconComponent size={isCompact ? 18 : 16} />}
          {/* Icon-only sidebar: the badges sit on the tile corners */}
          {isCompact && tabBadges}
        </div>
        {!isCompact && (
          <span className="session-name">{displayName}</span>
        )}
        {!isCompact && tabBadges}
      </motion.div>
    </SessionTooltip>
  )
}
