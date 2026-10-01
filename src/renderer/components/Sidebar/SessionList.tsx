import { useState, useRef, useEffect, useLayoutEffect, useMemo } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { useSessionStore, Folder, Session } from '../../stores/sessionStore'
import { useTerminalStore } from '../../stores/terminalStore'
import { groupTabsBySession } from '../../lib/sessionTabs'
import { RiFolderFill, RiArrowDownSFill, RiArrowRightSFill, RiDeleteBinLine, RiEditLine, RiFolderAddLine, RiCloseLine, RiPaletteLine, RiAddLine, RiFileCopyLine, RiServerLine } from 'react-icons/ri'
import { collapseVariants } from '../../lib/animation/variants'
import { useReducedMotion } from '../../hooks/useReducedMotion'
import { MoveToFolderSubmenu } from './MoveToFolderSubmenu'
import { SessionItem } from './SessionItem'
import { CompactFolderMarker } from './CompactFolderMarker'
import { getDropPosition, type DropPosition } from '../../lib/sessionOrder'
import { getFolderPath } from '../../lib/folderPath'
import { confirmDialog } from '../../stores/confirmStore'
import { placeContextMenu } from '../../lib/sidePanelPlacement'
import { SESSION_COLORS } from '../../lib/sessionColors'

interface ContextMenuState {
  visible: boolean
  x: number
  y: number
  type: 'folder' | 'session' | null
  targetId: string | null
}

interface DragState {
  type: 'session' | 'folder' | null
  id: string | null
}

interface SessionListProps {
  onQuickConnect: (session: any) => void
  onEditSession?: (session: Session) => void
  onDuplicateSession?: (session: Session) => void
  onAddSession?: (folderId?: string) => void
  isCompact?: boolean
}

export function SessionList({ onQuickConnect, onEditSession, onDuplicateSession, onAddSession, isCompact = false }: SessionListProps) {
  const { sessions, folders, expandedFolders, toggleFolder, addFolder, updateFolder, removeFolder, removeSession, moveSessionToFolder, reorderSession, updateSession, saveToBackend } = useSessionStore()
  const reducedMotion = useReducedMotion()
  const terminals = useTerminalStore(state => state.terminals)
  const sessionTabs = useMemo(() => groupTabsBySession(terminals), [terminals])
  const [colorPickerFolderId, setColorPickerFolderId] = useState<string | null>(null)
  const [colorPickerSessionId, setColorPickerSessionId] = useState<string | null>(null)

  const [contextMenu, setContextMenu] = useState<ContextMenuState>({
    visible: false,
    x: 0,
    y: 0,
    type: null,
    targetId: null
  })

  const [editingId, setEditingId] = useState<string | null>(null)
  const [editingName, setEditingName] = useState('')
  const editInputRef = useRef<HTMLInputElement>(null)

  // Drag state
  const [dragState, setDragState] = useState<DragState>({ type: null, id: null })
  const [dropTargetId, setDropTargetId] = useState<string | null>(null)
  // Reordering: the session under the pointer and which half of it
  const [sessionDropTarget, setSessionDropTarget] = useState<{ id: string; position: DropPosition } | null>(null)

  // Helper function to get folder's effective color (traverses parent chain)
  const getFolderEffectiveColor = (folderId: string): string | undefined => {
    const folder = folders.find(f => f.id === folderId)
    if (!folder) return undefined
    if (folder.backgroundColor) return folder.backgroundColor
    if (folder.parentId) {
      return getFolderEffectiveColor(folder.parentId)
    }
    return undefined
  }

  // Helper function to get effective color (session color or folder chain color)
  const getEffectiveColor = (session: Session): string | undefined => {
    if (session.backgroundColor) return session.backgroundColor
    if (session.folderId) {
      return getFolderEffectiveColor(session.folderId)
    }
    return undefined
  }

  // Keep the menu inside the window: open upward / leftward from the pointer near the edges.
  // Without this the lower items ("폴더로 이동", "삭제") of a session near the bottom were off-screen.
  const contextMenuRef = useRef<HTMLDivElement>(null)
  const [contextMenuPosition, setContextMenuPosition] = useState<{ x: number; y: number } | null>(null)
  useLayoutEffect(() => {
    const menu = contextMenuRef.current
    if (!contextMenu.visible || !menu) {
      setContextMenuPosition(null)
      return
    }
    setContextMenuPosition(placeContextMenu(
      { x: contextMenu.x, y: contextMenu.y },
      { width: menu.offsetWidth, height: menu.offsetHeight },
      { width: window.innerWidth, height: window.innerHeight }
    ))
  }, [contextMenu.visible, contextMenu.x, contextMenu.y, contextMenu.type])

  // Close context menu on click outside
  useEffect(() => {
    const handleClick = () => setContextMenu(prev => ({ ...prev, visible: false }))
    if (contextMenu.visible) {
      document.addEventListener('click', handleClick)
      return () => document.removeEventListener('click', handleClick)
    }
  }, [contextMenu.visible])

  // Focus edit input when editing
  useEffect(() => {
    if (editingId && editInputRef.current) {
      editInputRef.current.focus()
      editInputRef.current.select()
    }
  }, [editingId])

  // Drag handlers
  const handleDragStart = (e: React.DragEvent, type: 'session' | 'folder', id: string) => {
    e.stopPropagation()
    setDragState({ type, id })
    e.dataTransfer.effectAllowed = 'move'
    e.dataTransfer.setData('text/plain', `${type}:${id}`)
  }

  const handleDragEnd = () => {
    setDragState({ type: null, id: null })
    setDropTargetId(null)
    setSessionDropTarget(null)
  }

  // Session dropped on a session: place it before/after that one. Folder drags fall through
  // to the folder and root handlers underneath.
  const handleSessionDragOver = (e: React.DragEvent, targetId: string) => {
    if (dragState.type !== 'session' || !dragState.id) return
    e.stopPropagation()
    if (dragState.id === targetId) {
      setSessionDropTarget(null)
      return
    }
    e.preventDefault()
    e.dataTransfer.dropEffect = 'move'
    const position = getDropPosition(e.currentTarget.getBoundingClientRect(), e.clientY)
    setDropTargetId(null)
    setSessionDropTarget(prev => (prev?.id === targetId && prev.position === position ? prev : { id: targetId, position }))
  }

  const handleSessionDragLeave = (e: React.DragEvent, targetId: string) => {
    if (e.currentTarget.contains(e.relatedTarget as Node)) return
    setSessionDropTarget(prev => (prev?.id === targetId ? null : prev))
  }

  const handleSessionDrop = (e: React.DragEvent, targetId: string) => {
    if (dragState.type !== 'session' || !dragState.id) return
    e.preventDefault()
    e.stopPropagation()
    if (dragState.id !== targetId) {
      reorderSession(dragState.id, targetId, getDropPosition(e.currentTarget.getBoundingClientRect(), e.clientY))
      saveToBackend()
    }
    setSessionDropTarget(null)
    setDropTargetId(null)
  }

  const sessionItemDropProps = (sessionId: string) => ({
    onItemDragOver: handleSessionDragOver,
    onItemDragLeave: handleSessionDragLeave,
    onItemDrop: handleSessionDrop,
    dropIndicator: sessionDropTarget?.id === sessionId ? sessionDropTarget.position : null
  })

  const handleFolderDragOver = (e: React.DragEvent, targetFolderId: string) => {
    e.preventDefault()
    e.stopPropagation()

    if (!dragState.type || !dragState.id) return

    // Don't allow dropping on itself
    if (dragState.type === 'folder' && dragState.id === targetFolderId) {
      return
    }

    // Don't allow dropping a folder into its own descendant
    if (dragState.type === 'folder') {
      if (isDescendantOf(targetFolderId, dragState.id)) {
        return
      }
    }

    setDropTargetId(targetFolderId)
  }

  const handleFolderDragLeave = (e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    // Only clear if leaving to outside
    const relatedTarget = e.relatedTarget as HTMLElement
    if (!relatedTarget || !e.currentTarget.contains(relatedTarget)) {
      // Don't clear immediately - let dragOver on another element set it
    }
  }

  const handleFolderDrop = (e: React.DragEvent, targetFolderId: string) => {
    e.preventDefault()
    e.stopPropagation()

    if (!dragState.type || !dragState.id) {
      setDropTargetId(null)
      return
    }

    // Don't allow dropping on itself
    if (dragState.type === 'folder' && dragState.id === targetFolderId) {
      setDropTargetId(null)
      return
    }

    // Don't allow dropping a folder into its own descendant
    if (dragState.type === 'folder') {
      if (isDescendantOf(targetFolderId, dragState.id)) {
        setDropTargetId(null)
        return
      }
    }

    if (dragState.type === 'session') {
      moveSessionToFolder(dragState.id, targetFolderId)
      saveToBackend()
    } else if (dragState.type === 'folder') {
      updateFolder(dragState.id, { parentId: targetFolderId })
      saveToBackend()
    }

    setDropTargetId(null)
  }

  const handleRootDrop = (e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()

    if (!dragState.type || !dragState.id) {
      setDropTargetId(null)
      return
    }

    if (dragState.type === 'session') {
      moveSessionToFolder(dragState.id, undefined)
      saveToBackend()
    } else if (dragState.type === 'folder') {
      updateFolder(dragState.id, { parentId: undefined })
      saveToBackend()
    }

    setDropTargetId(null)
  }

  // Check if folderId is a descendant of parentId
  const isDescendantOf = (folderId: string, parentId: string): boolean => {
    const folder = folders.find(f => f.id === folderId)
    if (!folder) return false
    if (folder.parentId === parentId) return true
    if (folder.parentId) return isDescendantOf(folder.parentId, parentId)
    return false
  }

  const handleFolderContextMenu = (e: React.MouseEvent, folderId: string) => {
    e.preventDefault()
    e.stopPropagation()
    setContextMenu({
      visible: true,
      x: e.clientX,
      y: e.clientY,
      type: 'folder',
      targetId: folderId
    })
  }

  const handleSessionContextMenu = (e: React.MouseEvent, sessionId: string) => {
    e.preventDefault()
    e.stopPropagation()
    setContextMenu({
      visible: true,
      x: e.clientX,
      y: e.clientY,
      type: 'session',
      targetId: sessionId
    })
  }

  const handleAddSubfolder = () => {
    if (!contextMenu.targetId) return
    const newFolder: Folder = {
      id: crypto.randomUUID(),
      name: '새 폴더',
      parentId: contextMenu.targetId
    }
    addFolder(newFolder)
    saveToBackend()
    if (!expandedFolders.has(contextMenu.targetId)) {
      toggleFolder(contextMenu.targetId)
    }
    setEditingId(newFolder.id)
    setEditingName(newFolder.name)
    setContextMenu(prev => ({ ...prev, visible: false }))
  }

  const handleRenameFolder = () => {
    if (!contextMenu.targetId) return
    const folder = folders.find(f => f.id === contextMenu.targetId)
    if (folder) {
      setEditingId(folder.id)
      setEditingName(folder.name)
    }
    setContextMenu(prev => ({ ...prev, visible: false }))
  }

  const handleDeleteFolder = async () => {
    const folderId = contextMenu.targetId
    if (!folderId) return
    setContextMenu(prev => ({ ...prev, visible: false }))
    const confirmed = await confirmDialog({
      title: '폴더 삭제',
      message: `"${getFolderPath(folders, folderId)}" 폴더와 하위 폴더를 삭제합니다.
안에 있던 세션은 지워지지 않고 최상위로 옮겨집니다.`,
      confirmLabel: '삭제',
      danger: true
    })
    if (!confirmed) return
    removeFolder(folderId)
    saveToBackend()
  }

  const handleChangeFolderColor = () => {
    if (!contextMenu.targetId) return
    setColorPickerFolderId(contextMenu.targetId)
    setContextMenu(prev => ({ ...prev, visible: false }))
  }

  const handleSelectFolderColor = (color: string | undefined) => {
    if (!colorPickerFolderId) return
    updateFolder(colorPickerFolderId, { backgroundColor: color })
    saveToBackend()
    setColorPickerFolderId(null)
  }

  const handleAddSessionToFolder = () => {
    if (!contextMenu.targetId || !onAddSession) return
    onAddSession(contextMenu.targetId)
    setContextMenu(prev => ({ ...prev, visible: false }))
  }

  const handleChangeSessionColor = () => {
    if (!contextMenu.targetId) return
    setColorPickerSessionId(contextMenu.targetId)
    setContextMenu(prev => ({ ...prev, visible: false }))
  }

  const handleSelectSessionColor = (color: string | undefined) => {
    if (!colorPickerSessionId) return
    updateSession(colorPickerSessionId, { backgroundColor: color })
    saveToBackend()
    setColorPickerSessionId(null)
  }

  const handleEditSession = () => {
    if (!contextMenu.targetId) return
    const session = sessions.find(s => s.id === contextMenu.targetId)
    if (session && onEditSession) {
      onEditSession(session)
    }
    setContextMenu(prev => ({ ...prev, visible: false }))
  }

  const handleDuplicateSession = () => {
    if (!contextMenu.targetId) return
    const session = sessions.find(s => s.id === contextMenu.targetId)
    if (session && onDuplicateSession) {
      onDuplicateSession(session)
    }
    setContextMenu(prev => ({ ...prev, visible: false }))
  }

  const handleDeleteSession = async () => {
    const sessionId = contextMenu.targetId
    if (!sessionId) return
    setContextMenu(prev => ({ ...prev, visible: false }))
    const session = sessions.find(s => s.id === sessionId)
    const confirmed = await confirmDialog({
      title: '연결 삭제',
      message: `"${session?.name || session?.host || '이 연결'}" 연결 정보를 삭제합니다.
삭제한 연결은 되돌릴 수 없습니다.`,
      confirmLabel: '삭제',
      danger: true
    })
    if (!confirmed) return
    removeSession(sessionId)
    saveToBackend()
  }

  const handleMoveToFolder = async (folderId: string | undefined) => {
    const sessionId = contextMenu.targetId
    if (!sessionId) return
    const session = sessions.find(s => s.id === sessionId)
    if (!session) return
    setContextMenu(prev => ({ ...prev, visible: false }))
    const destination = folderId ? `"${getFolderPath(folders, folderId)}" 폴더로` : '최상위(폴더 없음)로'
    const confirmed = await confirmDialog({
      title: '세션 이동',
      message: `"${session.name || session.host}" 세션을 ${destination} 이동합니다.`,
      confirmLabel: '이동'
    })
    if (!confirmed) return
    moveSessionToFolder(sessionId, folderId)
    saveToBackend()
  }

  const handleEditSubmit = () => {
    if (editingId && editingName.trim()) {
      updateFolder(editingId, { name: editingName.trim() })
      saveToBackend()
    }
    setEditingId(null)
    setEditingName('')
  }

  const handleEditKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      handleEditSubmit()
    } else if (e.key === 'Escape') {
      setEditingId(null)
      setEditingName('')
    }
  }

  // Get child folders for a parent
  const getChildFolders = (parentId?: string) => {
    return folders.filter(f => f.parentId === parentId)
  }

  // Get sessions for a folder
  const getSessionsInFolder = (folderId: string) => {
    return sessions.filter(s => s.folderId === folderId)
  }

  // Get root sessions (no folder)
  const getRootSessions = () => {
    return sessions.filter(s => !s.folderId)
  }

  // Get current session's folder for context menu
  const getCurrentSessionFolder = () => {
    if (!contextMenu.targetId) return undefined
    const session = sessions.find(s => s.id === contextMenu.targetId)
    return session?.folderId
  }

  // Recursive folder renderer
  const renderFolder = (folder: Folder, depth: number = 0) => {
    const isExpanded = expandedFolders.has(folder.id)
    const childFolders = getChildFolders(folder.id)
    const folderSessions = getSessionsInFolder(folder.id)
    const isEditing = editingId === folder.id
    const isDragging = dragState.type === 'folder' && dragState.id === folder.id
    const isDropTarget = dropTargetId === folder.id
    const folderEffectiveColor = getFolderEffectiveColor(folder.id)

    const sessionItems = folderSessions.map(session => (
      <SessionItem
        key={session.id}
        session={session}
        onConnect={onQuickConnect}
        onContextMenu={handleSessionContextMenu}
        onDragStart={handleDragStart}
        onDragEnd={handleDragEnd}
        isDragging={dragState.type === 'session' && dragState.id === session.id}
        isCompact={isCompact}
        reducedMotion={reducedMotion}
        tabs={sessionTabs.get(session.id)}
        effectiveColor={getEffectiveColor(session)}
        {...sessionItemDropProps(session.id)}
      />
    ))

    return (
      <div key={folder.id} className="session-folder">
        {isCompact && (
          <CompactFolderMarker
            folder={folder}
            depth={depth}
            parentPath={folder.parentId ? getFolderPath(folders, folder.parentId) : undefined}
            subfolderCount={childFolders.length}
            isExpanded={isExpanded}
            sessionCount={folderSessions.length}
            color={folderEffectiveColor}
            isDropTarget={isDropTarget}
            onToggle={() => toggleFolder(folder.id)}
            onContextMenu={(e) => handleFolderContextMenu(e, folder.id)}
            onDragOver={(e) => handleFolderDragOver(e, folder.id)}
            onDragLeave={handleFolderDragLeave}
            onDrop={(e) => handleFolderDrop(e, folder.id)}
          />
        )}
        {!isCompact && (
          <div
            className={`folder-header ${isDragging ? 'dragging' : ''} ${isDropTarget ? 'drop-target' : ''}`}
            role="treeitem"
            aria-expanded={isExpanded}
            aria-label={`Folder: ${folder.name}`}
            onClick={() => toggleFolder(folder.id)}
            onContextMenu={(e) => handleFolderContextMenu(e, folder.id)}
            draggable={!isEditing}
            onDragStart={(e) => handleDragStart(e, 'folder', folder.id)}
            onDragEnd={handleDragEnd}
            onDragOver={(e) => handleFolderDragOver(e, folder.id)}
            onDragLeave={handleFolderDragLeave}
            onDrop={(e) => handleFolderDrop(e, folder.id)}
            style={folderEffectiveColor ? {
              borderLeft: `3px solid ${folderEffectiveColor}`,
              background: `${folderEffectiveColor}20`
            } : undefined}
          >
            {isExpanded ? <RiArrowDownSFill size={16} /> : <RiArrowRightSFill size={16} />}
            <RiFolderFill size={16} />
            {isEditing ? (
              <input
                ref={editInputRef}
                type="text"
                className="folder-edit-input"
                value={editingName}
                onChange={(e) => setEditingName(e.target.value)}
                onBlur={handleEditSubmit}
                onKeyDown={handleEditKeyDown}
                onClick={(e) => e.stopPropagation()}
              />
            ) : (
              <span>{folder.name}</span>
            )}
          </div>
        )}
        <AnimatePresence initial={false}>
          {isExpanded && (
            <motion.div
              className={`folder-contents ${isDropTarget ? 'drop-target' : ''}`}
              variants={reducedMotion ? undefined : collapseVariants}
              initial="hidden"
              animate="visible"
              exit="hidden"
              onDragOver={(e) => handleFolderDragOver(e, folder.id)}
              onDrop={(e) => handleFolderDrop(e, folder.id)}
            >
              {/* Icon-only mode has no indentation, so a folder's own sessions go right under its
                  marker; otherwise they would read as part of the last subfolder */}
              {isCompact && sessionItems}
              {childFolders.map(child => renderFolder(child, depth + 1))}
              {!isCompact && sessionItems}
              {!isCompact && childFolders.length === 0 && folderSessions.length === 0 && (
                <div className="folder-empty-drop-zone">폴더가 비어 있습니다</div>
              )}
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    )
  }

  if (sessions.length === 0 && folders.length === 0) {
    return (
      <div className="session-list-empty">
        {isCompact ? (
          <span className="session-list-empty-icon" title="저장된 연결이 없습니다" aria-label="저장된 연결이 없습니다">
            <RiServerLine size={20} />
          </span>
        ) : (
          <>
            <p>저장된 연결이 없습니다</p>
            <p className="text-muted">새 연결을 추가해주세요</p>
          </>
        )}
      </div>
    )
  }

  const rootFolders = getChildFolders(undefined)
  const rootSessions = getRootSessions()
  const isRootDropTarget = dropTargetId === 'root'

  return (
    <div
      className="session-list"
      role="tree"
      aria-label="SSH session list"
      onDragOver={(e) => {
        e.preventDefault()
        if (dragState.type) {
          setDropTargetId('root')
        }
      }}
      onDragLeave={(e) => {
        const rect = e.currentTarget.getBoundingClientRect()
        const x = e.clientX
        const y = e.clientY
        if (x < rect.left || x > rect.right || y < rect.top || y > rect.bottom) {
          setDropTargetId(null)
        }
      }}
      onDrop={handleRootDrop}
    >
      {rootFolders.map(folder => renderFolder(folder))}
      <div className={`root-sessions ${isRootDropTarget ? 'drop-target' : ''}`}>
        {rootSessions.map(session => (
          <SessionItem
            key={session.id}
            session={session}
            onConnect={onQuickConnect}
            onContextMenu={handleSessionContextMenu}
            onDragStart={handleDragStart}
            onDragEnd={handleDragEnd}
            isDragging={dragState.type === 'session' && dragState.id === session.id}
            isCompact={isCompact}
            reducedMotion={reducedMotion}
            tabs={sessionTabs.get(session.id)}
            effectiveColor={getEffectiveColor(session)}
            {...sessionItemDropProps(session.id)}
          />
        ))}
      </div>

      {/* Folder Color Picker Modal */}
      {colorPickerFolderId && (
        <div
          className="context-menu"
          style={{
            left: '50%',
            top: '50%',
            transform: 'translate(-50%, -50%)',
            minWidth: '200px'
          }}
          onClick={(e) => e.stopPropagation()}
        >
          <div className="context-menu-section-title">폴더 색상 선택</div>
          <div className="color-selector">
            <button
              className="color-option none"
              onClick={() => handleSelectFolderColor(undefined)}
              title="없음"
            >
              ✕
            </button>
            {SESSION_COLORS.map((colorItem) => (
              <button
                key={colorItem.id}
                className="color-option"
                style={{ backgroundColor: colorItem.color }}
                onClick={() => handleSelectFolderColor(colorItem.color)}
                title={colorItem.name}
              />
            ))}
          </div>
          <div className="context-menu-divider" />
          <div className="context-menu-item" onClick={() => setColorPickerFolderId(null)}>
            <RiCloseLine size={16} />
            <span>취소</span>
          </div>
        </div>
      )}

      {/* Session Color Picker Modal */}
      {colorPickerSessionId && (
        <div
          className="context-menu"
          style={{
            left: '50%',
            top: '50%',
            transform: 'translate(-50%, -50%)',
            minWidth: '200px'
          }}
          onClick={(e) => e.stopPropagation()}
        >
          <div className="context-menu-section-title">세션 색상 선택</div>
          <div className="color-selector">
            <button
              className="color-option none"
              onClick={() => handleSelectSessionColor(undefined)}
              title="없음"
            >
              ✕
            </button>
            {SESSION_COLORS.map((colorItem) => (
              <button
                key={colorItem.id}
                className="color-option"
                style={{ backgroundColor: colorItem.color }}
                onClick={() => handleSelectSessionColor(colorItem.color)}
                title={colorItem.name}
              />
            ))}
          </div>
          <div className="context-menu-divider" />
          <div className="context-menu-item" onClick={() => setColorPickerSessionId(null)}>
            <RiCloseLine size={16} />
            <span>취소</span>
          </div>
        </div>
      )}

      {/* Context Menu */}
      {contextMenu.visible && (
        <div
          ref={contextMenuRef}
          className="context-menu"
          style={contextMenuPosition
            ? { left: contextMenuPosition.x, top: contextMenuPosition.y }
            : { left: contextMenu.x, top: contextMenu.y, visibility: 'hidden' }}
          onClick={(e) => e.stopPropagation()}
        >
          {contextMenu.type === 'folder' && (
            <>
              {onAddSession && (
                <div className="context-menu-item" onClick={handleAddSessionToFolder}>
                  <RiAddLine size={16} />
                  <span>세션 추가</span>
                </div>
              )}
              <div className="context-menu-item" onClick={handleAddSubfolder}>
                <RiFolderAddLine size={16} />
                <span>하위 폴더 추가</span>
              </div>
              <div className="context-menu-item" onClick={handleRenameFolder}>
                <RiEditLine size={16} />
                <span>이름 변경</span>
              </div>
              <div className="context-menu-item" onClick={handleChangeFolderColor}>
                <RiPaletteLine size={16} />
                <span>색상 변경</span>
              </div>
              <div className="context-menu-divider" />
              <div className="context-menu-item danger" onClick={handleDeleteFolder}>
                <RiDeleteBinLine size={16} />
                <span>삭제</span>
              </div>
            </>
          )}
          {contextMenu.type === 'session' && (
            <>
              <div className="context-menu-item" onClick={handleEditSession}>
                <RiEditLine size={16} />
                <span>수정</span>
              </div>
              {onDuplicateSession && (
                <div className="context-menu-item" onClick={handleDuplicateSession}>
                  <RiFileCopyLine size={16} />
                  <span>복제</span>
                </div>
              )}
              <div className="context-menu-item" onClick={handleChangeSessionColor}>
                <RiPaletteLine size={16} />
                <span>색상 변경</span>
              </div>
              <MoveToFolderSubmenu
                folders={folders}
                currentFolderId={getCurrentSessionFolder()}
                onMove={handleMoveToFolder}
              />
              <div className="context-menu-divider" />
              <div className="context-menu-item danger" onClick={handleDeleteSession}>
                <RiDeleteBinLine size={16} />
                <span>삭제</span>
              </div>
            </>
          )}
        </div>
      )}
    </div>
  )
}
