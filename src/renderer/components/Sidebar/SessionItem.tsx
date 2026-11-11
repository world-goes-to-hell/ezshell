import { motion } from 'framer-motion'
import { RiServerFill, RiDatabase2Fill, RiCloudFill, RiGlobalFill, RiHomeFill, RiComputerFill, RiHardDriveFill, RiCpuFill, RiBaseStationFill, RiPlugLine } from 'react-icons/ri'
import type { Session } from '../../stores/sessionStore'
import { SessionIcon } from '../Modal/ConnectModal'
import { SessionTooltip } from './SessionTooltip'
import { SessionTabBadge } from './SessionTabBadge'
import type { DropPosition } from '../../lib/sessionOrder'
import type { SessionTabGroup } from '../../lib/sessionTabs'
import './SessionMcpMark.css'

const MCP_MARK_LABEL = 'Claude Code(MCP) 접근 허용됨'

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
  /** Tabs currently open from this session; absent when there are none */
  tabs?: SessionTabGroup
}

const DEFAULT_ICON: SessionIcon = 'server'

/** A session's own color goes through a CSS variable so hover rules still apply */
type ColorStyle = React.CSSProperties & { '--session-color'?: string }

function getItemStyle(color: string | undefined): ColorStyle | undefined {
  if (!color) return undefined
  // Rows carry no fill: the folder's line shows the colour, and a session with a colour of its own
  // gets a short line of it (SidebarTree.css)
  return { '--session-color': color }
}

export function SessionItem({
  session, onConnect, onContextMenu, onDragStart, onDragEnd, onItemDragOver, onItemDragLeave, onItemDrop,
  dropIndicator, isDragging, tabs
}: SessionItemProps) {
  const isActive = (tabs?.connected.length ?? 0) > 0
  const tabBadges = tabs && (
    // Focus moving to a badge or into its tab list (a portal, still a React child) must not reach the row
    <div className="session-tab-badges" onFocus={(e) => e.stopPropagation()}>
      <SessionTabBadge status="connected" tabs={tabs.connected} />
      <SessionTabBadge status="disconnected" tabs={tabs.disconnected} />
    </div>
  )
  // The hover card says it instead of a native title, which would open on top of the card
  const mcpMark = session.mcpEnabled === true && (
    <span className="session-mcp-mark" role="img" aria-label={MCP_MARK_LABEL}>
      <RiPlugLine size={12} />
    </span>
  )
  const iconId = (session.icon as SessionIcon) || DEFAULT_ICON
  const IconComponent = ICON_MAP[iconId] || RiServerFill
  const displayName = session.name || session.host

  const classNames = [
    'session-item',
    isDragging && 'dragging',
    isActive && 'active',
    // Only lost tabs: the state dot turns red
    !isActive && (tabs?.disconnected.length ?? 0) > 0 && 'has-lost',
    session.backgroundColor && 'has-own-color',
    dropIndicator && `drop-${dropIndicator}`
  ].filter(Boolean).join(' ')

  return (
    <SessionTooltip session={session} tabs={tabs} compact={false}>
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
        style={getItemStyle(session.backgroundColor)}
      >
        <div className="session-item-icon">
          {/* Every session shares the default icon, so a state dot says more: green while a tab is connected */}
          {iconId === DEFAULT_ICON
            ? <span className="session-dot" aria-hidden="true" />
            : <IconComponent size={14} />}
        </div>
        <span className="session-name">{displayName}</span>
        {mcpMark}
        {tabBadges}
      </motion.div>
    </SessionTooltip>
  )
}
