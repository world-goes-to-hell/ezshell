import { useLayoutEffect, useMemo, useRef, useState, type JSX } from 'react'
import { RiFolderTransferLine, RiArrowRightSLine, RiArrowDownSFill, RiArrowRightSFill, RiFolderFill, RiHome4Line } from 'react-icons/ri'
import type { Folder } from '../../stores/sessionStore'
import './MoveToFolderSubmenu.css'

interface MoveToFolderSubmenuProps {
  folders: Folder[]
  /** Folder the session is in now; undefined = top level */
  currentFolderId?: string
  onMove: (folderId: string | undefined) => void
}

const PANEL_GAP_PX = 4
const VIEWPORT_MARGIN_PX = 8
const CLOSE_DELAY_MS = 150

/** Ids of the current folder's ancestors, so the tree opens with the current location visible. */
function ancestorIds(folders: Folder[], folderId?: string): Set<string> {
  const byId = new Map(folders.map(f => [f.id, f]))
  const result = new Set<string>()
  let parentId = folderId ? byId.get(folderId)?.parentId : undefined
  while (parentId && !result.has(parentId)) {
    result.add(parentId)
    parentId = byId.get(parentId)?.parentId
  }
  return result
}

/**
 * "폴더로 이동 ›" context-menu entry. Hover or click opens a side panel with the folder tree
 * (right of the menu, or left when there is no room), instead of listing every folder inline.
 */
export function MoveToFolderSubmenu({ folders, currentFolderId, onMove }: MoveToFolderSubmenuProps) {
  const [isOpen, setIsOpen] = useState(false)
  const [openLeft, setOpenLeft] = useState(false)
  const [expanded, setExpanded] = useState<Set<string>>(() => ancestorIds(folders, currentFolderId))
  const anchorRef = useRef<HTMLDivElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const childrenOf = useMemo(() => {
    const map = new Map<string | undefined, Folder[]>()
    folders.forEach(folder => {
      const list = map.get(folder.parentId) ?? []
      map.set(folder.parentId, [...list, folder])
    })
    return map
  }, [folders])

  // Flip to the left side when the panel would run off the right edge of the window
  useLayoutEffect(() => {
    if (!isOpen || !anchorRef.current || !panelRef.current) return
    const anchor = anchorRef.current.getBoundingClientRect()
    const panelWidth = panelRef.current.offsetWidth
    setOpenLeft(anchor.right + PANEL_GAP_PX + panelWidth > window.innerWidth - VIEWPORT_MARGIN_PX)
  }, [isOpen])

  const open = () => {
    if (closeTimer.current) clearTimeout(closeTimer.current)
    setIsOpen(true)
  }

  // Small delay so moving the pointer diagonally from the item into the panel does not close it
  const scheduleClose = () => {
    if (closeTimer.current) clearTimeout(closeTimer.current)
    closeTimer.current = setTimeout(() => setIsOpen(false), CLOSE_DELAY_MS)
  }

  const toggleExpanded = (folderId: string) => {
    setExpanded(prev => {
      const next = new Set(prev)
      if (next.has(folderId)) next.delete(folderId)
      else next.add(folderId)
      return next
    })
  }

  const renderTree = (parentId: string | undefined, depth: number): JSX.Element[] =>
    (childrenOf.get(parentId) ?? []).map(folder => {
      const hasChildren = (childrenOf.get(folder.id) ?? []).length > 0
      const isExpanded = expanded.has(folder.id)
      const isCurrent = folder.id === currentFolderId
      return (
        <div key={folder.id} role="none">
          <div
            role="treeitem"
            aria-expanded={hasChildren ? isExpanded : undefined}
            aria-current={isCurrent ? 'location' : undefined}
            className={`folder-move-item ${isCurrent ? 'is-current' : ''}`}
            style={{ paddingLeft: 8 + depth * 16 }}
            onClick={() => !isCurrent && onMove(folder.id)}
          >
            <button
              type="button"
              className="folder-move-toggle"
              aria-label={isExpanded ? '접기' : '펼치기'}
              tabIndex={-1}
              style={{ visibility: hasChildren ? 'visible' : 'hidden' }}
              onClick={e => {
                e.stopPropagation()
                toggleExpanded(folder.id)
              }}
            >
              {isExpanded ? <RiArrowDownSFill size={16} /> : <RiArrowRightSFill size={16} />}
            </button>
            <RiFolderFill size={16} className="folder-move-icon" style={folder.backgroundColor ? { color: folder.backgroundColor } : undefined} />
            <span className="folder-move-name">{folder.name}</span>
            {isCurrent && <span className="current-badge">현재</span>}
          </div>
          {hasChildren && isExpanded && renderTree(folder.id, depth + 1)}
        </div>
      )
    })

  return (
    <div className="folder-move" ref={anchorRef} onMouseEnter={open} onMouseLeave={scheduleClose}>
      <div
        className={`context-menu-item folder-move-trigger ${isOpen ? 'is-open' : ''}`}
        role="menuitem"
        aria-haspopup="true"
        aria-expanded={isOpen}
        onClick={() => setIsOpen(prev => !prev)}
      >
        <RiFolderTransferLine size={16} />
        <span>폴더로 이동</span>
        <RiArrowRightSLine size={16} className="folder-move-chevron" />
      </div>

      {isOpen && (
        <div
          ref={panelRef}
          className={`folder-move-panel ${openLeft ? 'open-left' : ''}`}
          role="tree"
          aria-label="이동할 폴더"
          onMouseEnter={open}
        >
          <div className="folder-move-title">이동할 폴더 선택</div>
          <div
            role="treeitem"
            aria-current={!currentFolderId ? 'location' : undefined}
            className={`folder-move-item ${!currentFolderId ? 'is-current' : ''}`}
            style={{ paddingLeft: 8 }}
            onClick={() => currentFolderId && onMove(undefined)}
          >
            <span className="folder-move-toggle" aria-hidden="true" />
            <RiHome4Line size={16} className="folder-move-icon" />
            <span className="folder-move-name">최상위 (폴더 없음)</span>
            {!currentFolderId && <span className="current-badge">현재</span>}
          </div>
          {renderTree(undefined, 0)}
        </div>
      )}
    </div>
  )
}
