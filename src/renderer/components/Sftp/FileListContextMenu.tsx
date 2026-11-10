import { forwardRef, useImperativeHandle, useLayoutEffect, useRef, useState, type ReactElement } from 'react'
import { createPortal } from 'react-dom'
import {
  RiUploadFill, RiDownloadFill, RiDeleteBinFill, RiEditFill, RiFolderAddFill, RiRefreshFill, RiEyeFill, RiFileEditFill, RiPulseLine
} from 'react-icons/ri'
import type { FileItem } from '../../stores/sftpStore'
import { EDIT_MAX_BYTES, canFollowFile } from '../../lib/remoteFileText'

export type ContextMenuAction = 'upload' | 'download' | 'rename' | 'newFolder' | 'refresh' | 'delete' | 'preview' | 'tail' | 'edit'

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
  /** Remote files can be opened in the server file window (preview / edit) */
  canOpenFile?: boolean
}

const ICON_SIZE = 16
export const CONTEXT_MENU_ITEM_HEIGHT = 34
export const CONTEXT_MENU_WIDTH = 210

/** Items shown for the clicked row (or for empty space when `file` is null) */
export function buildContextMenuItems({ file, type, canRename, canCreateFolder, canDelete, canOpenFile = false }: MenuOptions): MenuItem[] {
  if (!file) {
    return [
      ...(canCreateFolder ? [{ action: 'newFolder' as const, label: '새 폴더', shortcut: 'Ctrl+Shift+N', icon: <RiFolderAddFill size={ICON_SIZE} /> }] : []),
      { action: 'refresh', label: '새로고침', shortcut: 'F5', icon: <RiRefreshFill size={ICON_SIZE} /> }
    ]
  }

  const opensFile = canOpenFile && type === 'remote' && file.type === 'file'
  const items: MenuItem[] = [
    ...(opensFile ? [{ action: 'preview' as const, label: '미리보기', icon: <RiEyeFill size={ICON_SIZE} /> }] : []),
    ...(opensFile && canFollowFile(file.name) ? [{ action: 'tail' as const, label: '실시간 보기', icon: <RiPulseLine size={ICON_SIZE} /> }] : []),
    ...(opensFile && file.size <= EDIT_MAX_BYTES ? [{ action: 'edit' as const, label: '편집', icon: <RiFileEditFill size={ICON_SIZE} /> }] : []),
    type === 'local'
      ? { action: 'upload', label: '업로드', icon: <RiUploadFill size={ICON_SIZE} />, separated: opensFile }
      : { action: 'download', label: '다운로드', icon: <RiDownloadFill size={ICON_SIZE} />, separated: opensFile }
  ]
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

/** Gap kept between the menu and the window edge */
const EDGE_GAP = 8

/**
 * Where the menu fits: at the click, or opening upwards when there is no room below, and moved in
 * from the right edge. Uses the menu's real size (dividers and longer item lists made estimates wrong).
 */
export function fitMenu(click: { x: number; y: number }, size: { width: number; height: number }, viewport: { width: number; height: number }): { top: number; left: number } {
  const fitsBelow = click.y + size.height <= viewport.height - EDGE_GAP
  const top = fitsBelow ? click.y : Math.max(EDGE_GAP, Math.min(click.y - size.height, viewport.height - size.height - EDGE_GAP))
  const left = Math.max(EDGE_GAP, Math.min(click.x, viewport.width - size.width - EDGE_GAP))
  return { top, left }
}

export const FileListContextMenu = forwardRef<HTMLDivElement, FileListContextMenuProps>(
  function FileListContextMenu({ x, y, items, onSelect }, ref) {
    const menuRef = useRef<HTMLDivElement>(null)
    useImperativeHandle(ref, () => menuRef.current as HTMLDivElement)
    const [position, setPosition] = useState({ top: y, left: x })

    // Measured before the first paint, so the menu never shows cut off for a frame
    useLayoutEffect(() => {
      const menu = menuRef.current
      if (!menu) return
      const { width, height } = menu.getBoundingClientRect()
      setPosition(fitMenu({ x, y }, { width, height }, { width: window.innerWidth, height: window.innerHeight }))
    }, [x, y, items.length])

    // On the page itself: inside the SFTP panel a transformed ancestor would clip a fixed menu
    return createPortal(
      <div ref={menuRef} className="context-menu sftp-context-menu" style={{ top: position.top, left: position.left }} role="menu">
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
      </div>,
      document.body
    )
  }
)
