import { RiFolderFill, RiFolderOpenFill, RiFolderLine, RiFolderOpenLine, RiFileFill, RiLinkM, RiLinkUnlinkM } from 'react-icons/ri'
import type { FileNode } from '../../lib/fileExplorerNodes'

const ICON_SIZE = 16
const BADGE_SIZE = 10

/**
 * Folder/file icon for the side SFTP explorer.
 * Symlinks get an outlined icon plus a small link badge so they read differently from real folders.
 */
export function FileExplorerIcon({ node }: { node: FileNode }) {
  const isDir = node.type === 'directory'

  if (!node.isSymlink) {
    if (!isDir) return <RiFileFill size={ICON_SIZE} className="file-icon" />
    return node.isExpanded
      ? <RiFolderOpenFill size={ICON_SIZE} className="folder-icon" />
      : <RiFolderFill size={ICON_SIZE} className="folder-icon" />
  }

  const Base = isDir ? (node.isExpanded ? RiFolderOpenLine : RiFolderLine) : RiFileFill
  const Badge = node.isBrokenLink ? RiLinkUnlinkM : RiLinkM
  return (
    <span className="file-explorer-link-icon">
      <Base size={ICON_SIZE} className={isDir ? 'folder-icon' : 'file-icon'} />
      <Badge size={BADGE_SIZE} className="file-explorer-link-badge" aria-hidden="true" />
    </span>
  )
}
