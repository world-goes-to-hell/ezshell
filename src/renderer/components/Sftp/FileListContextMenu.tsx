import { forwardRef, type ReactElement } from 'react'
import {
  RiUploadFill, RiDownloadFill, RiDeleteBinFill, RiEditFill, RiFolderAddFill, RiRefreshFill
} from 'react-icons/ri'
import type { FileItem } from '../../stores/sftpStore'

export type ContextMenuAction = 'upload' | 'download' | 'rename' | 'newFolder' | 'refresh' | 'delete'

interface MenuItem {
  action: ContextMenuAction
  label: string
  shortcut?: string
  icon: ReactElement
  danger?: boolean
  /** Draw a divider above this item */
  separated?: boolean
}

interface MenuOptions {
  /** null when the menu was opened on empty space in the list */
  file: FileItem | null
  type: 'local' | 'remote'
  canRename: boolean
  canCreateFolder: boolean
  canDelete: boolean
}

const ICON_SIZE = 16
export const CONTEXT_MENU_ITEM_HEIGHT = 34
export const CONTEXT_MENU_WIDTH = 210

/** Items shown for the clicked row (or for empty space when `file` is null) */
export function buildContextMenuItems({ file, type, canRename, canCreateFolder, canDelete }: MenuOptions): MenuItem[] {
  if (!file) {
    return [
      ...(canCreateFolder ? [{ action: 'newFolder' as const, label: '새 폴더', shortcut: 'Ctrl+Shift+N', icon: <RiFolderAddFill size={ICON_SIZE} /> }] : []),
      { action: 'refresh', label: '새로고침', shortcut: 'F5', icon: <RiRefreshFill size={ICON_SIZE} /> }
    ]
  }

  const items: MenuItem[] = type === 'local'
    ? [{ action: 'upload', label: '업로드', icon: <RiUploadFill size={ICON_SIZE} /> }]
    : [{ action: 'download', label: '다운로드', icon: <RiDownloadFill size={ICON_SIZE} /> }]
  if (canRename) items.push({ action: 'rename', label: '이름 바꾸기', shortcut: 'F2', icon: <RiEditFill size={ICON_SIZE} />, separated: true })
  if (canCreateFolder) items.push({ action: 'newFolder', label: '새 폴더', shortcut: 'Ctrl+Shift+N', icon: <RiFolderAddFill size={ICON_SIZE} />, separated: !canRename })
  if (canDelete) {
    items.push({
      action: 'delete',
      label: type === 'local' ? '휴지통으로 이동' : '삭제',
      shortcut: 'Delete',
      icon: <RiDeleteBinFill size={ICON_SIZE} />,
      danger: true,
      separated: true
    })
  }
  return items
}

interface FileListContextMenuProps {
  x: number
  y: number
  items: MenuItem[]
  onSelect: (action: ContextMenuAction) => void
}

export const FileListContextMenu = forwardRef<HTMLDivElement, FileListContextMenuProps>(
  function FileListContextMenu({ x, y, items, onSelect }, ref) {
    return (
      <div ref={ref} className="context-menu sftp-context-menu" style={{ top: y, left: x }} role="menu">
        {items.map(item => (
          <div key={item.action}>
            {item.separated && <div className="context-menu-divider" />}
            <div
              className={`context-menu-item ${item.danger ? 'danger' : ''}`}
              role="menuitem"
              onClick={() => onSelect(item.action)}
            >
              {item.icon}
              <span className="context-menu-label">{item.label}</span>
              {item.shortcut && <kbd className="context-menu-shortcut">{item.shortcut}</kbd>}
            </div>
          </div>
        ))}
      </div>
    )
  }
)
