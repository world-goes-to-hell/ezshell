import { useLayoutEffect, useRef, useState } from 'react'
import { RiFolderTransferLine, RiArrowRightSLine } from 'react-icons/ri'
import type { Folder } from '../../stores/sessionStore'
import { FolderTree } from '../FolderTree/FolderTree'
import { placeSidePanel, type SidePanelPlacement } from '../../lib/sidePanelPlacement'
import './MoveToFolderSubmenu.css'

interface MoveToFolderSubmenuProps {
  folders: Folder[]
  /** Folder the session is in now; undefined = top level */
  currentFolderId?: string
  onMove: (folderId: string | undefined) => void
}

const CLOSE_DELAY_MS = 150

/**
 * "폴더로 이동 ›" context-menu entry. Hover or click opens a side panel with the folder tree
 * instead of listing every folder inline. The panel stays inside the window: right of the menu,
 * else left, else pushed in; moved up near the bottom (re-placed as folders are expanded).
 */
export function MoveToFolderSubmenu({ folders, currentFolderId, onMove }: MoveToFolderSubmenuProps) {
  const [isOpen, setIsOpen] = useState(false)
  const [placement, setPlacement] = useState<SidePanelPlacement | null>(null)
  const anchorRef = useRef<HTMLDivElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  useLayoutEffect(() => {
    const anchorEl = anchorRef.current
    const panelEl = panelRef.current
    if (!isOpen || !anchorEl || !panelEl) {
      setPlacement(null)
      return
    }
    const place = () => setPlacement(placeSidePanel(
      anchorEl.getBoundingClientRect(),
      { width: panelEl.offsetWidth, height: panelEl.offsetHeight },
      { width: window.innerWidth, height: window.innerHeight }
    ))
    place()
    // Expanding folders makes the panel taller: keep it inside the window
    const observer = new ResizeObserver(place)
    observer.observe(panelEl)
    return () => observer.disconnect()
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
          className="folder-move-panel"
          style={placement ? {
            left: placement.left,
            top: placement.top,
            maxHeight: `min(420px, 70vh, ${placement.maxHeight}px)`
          } : { visibility: 'hidden' }}
          role="tree"
          aria-label="이동할 폴더"
          onMouseEnter={open}
        >
          <div className="folder-move-title">이동할 폴더 선택</div>
          <FolderTree
            folders={folders}
            markedFolderId={currentFolderId}
            markLabel="현재"
            rootLabel="최상위 (폴더 없음)"
            onPick={onMove}
          />
        </div>
      )}
    </div>
  )
}
