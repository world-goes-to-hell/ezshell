import * as Tooltip from '@radix-ui/react-tooltip'
import { RiArrowDownSFill, RiArrowRightSFill } from 'react-icons/ri'
import type { Folder } from '../../stores/sessionStore'
import { getAbbreviation } from '../../lib/sessionAbbreviation'
import './SessionTooltip.css'

interface CompactFolderMarkerProps {
  folder: Folder
  /** Nesting level; markers are indented so the hierarchy stays readable */
  depth: number
  /** "상위 / 하위" path of the parent folder, for nested folders */
  parentPath?: string
  subfolderCount: number
  isExpanded: boolean
  /** Sessions directly inside this folder (not counting subfolders) */
  sessionCount: number
  color?: string
  isDropTarget: boolean
  onToggle: () => void
  onContextMenu: (e: React.MouseEvent) => void
  onDragOver: (e: React.DragEvent) => void
  onDragLeave: (e: React.DragEvent) => void
  onDrop: (e: React.DragEvent) => void
}

const OPEN_DELAY_MS = 250
/** Deeper levels share the last indent; the 80px column has no room for more */
const MAX_INDENT_DEPTH = 3

type MarkerStyle = React.CSSProperties & { '--session-color'?: string; '--depth'?: number }

/**
 * Folder header for the icon-only sidebar: a short label that toggles the folder,
 * so groups stay visible and can be collapsed even without folder names.
 */
export function CompactFolderMarker({
  folder, depth, parentPath, subfolderCount, isExpanded, sessionCount, color, isDropTarget,
  onToggle, onContextMenu, onDragOver, onDragLeave, onDrop
}: CompactFolderMarkerProps) {
  const ChevronIcon = isExpanded ? RiArrowDownSFill : RiArrowRightSFill
  const style: MarkerStyle = {
    '--depth': Math.min(depth, MAX_INDENT_DEPTH),
    ...(color ? { '--session-color': color } : {})
  }
  const contents = [`세션 ${sessionCount}개`, subfolderCount > 0 && `하위 폴더 ${subfolderCount}개`].filter(Boolean).join(' · ')

  return (
    <Tooltip.Provider delayDuration={OPEN_DELAY_MS}>
      <Tooltip.Root>
        <Tooltip.Trigger asChild>
          <button
            type="button"
            className={`compact-folder-marker ${depth > 0 ? 'nested' : ''} ${color ? 'has-color' : ''} ${isDropTarget ? 'drop-target' : ''}`}
            aria-expanded={isExpanded}
            aria-label={`폴더: ${folder.name}`}
            onClick={onToggle}
            onContextMenu={onContextMenu}
            onDragOver={onDragOver}
            onDragLeave={onDragLeave}
            onDrop={onDrop}
            style={style}
          >
            <ChevronIcon size={14} className="compact-folder-chevron" />
            <span className="compact-folder-abbr">{getAbbreviation(folder.name)}</span>
          </button>
        </Tooltip.Trigger>
        <Tooltip.Portal>
          <Tooltip.Content className="session-tooltip" side="right" sideOffset={10} collisionPadding={8}>
            <div className="session-tooltip-name">{folder.name}</div>
            {parentPath && <div className="session-tooltip-address">{parentPath} /</div>}
            <div className="session-tooltip-meta">
              <span>{contents}</span>
            </div>
            <div className="session-tooltip-hint">클릭하여 {isExpanded ? '접기' : '펼치기'}</div>
          </Tooltip.Content>
        </Tooltip.Portal>
      </Tooltip.Root>
    </Tooltip.Provider>
  )
}
