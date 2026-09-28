import { useState, useRef, useEffect, type JSX } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { useSessionStore, Folder, Session } from '../../stores/sessionStore'
import { RiServerFill, RiFolderFill, RiArrowDownSFill, RiArrowRightSFill, RiDatabase2Fill, RiCloudFill, RiGlobalFill, RiHomeFill, RiComputerFill, RiHardDriveFill, RiCpuFill, RiBaseStationFill, RiDeleteBinLine, RiEditLine, RiFolderAddLine, RiFilterLine, RiCloseLine, RiPaletteLine, RiAddLine } from 'react-icons/ri'
import { SessionIcon } from '../Modal/ConnectModal'
import { collapseVariants } from '../../lib/animation/variants'
import { useReducedMotion } from '../../hooks/useReducedMotion'
import { StatusIndicator } from '../Animation'
import { TagBadge } from '../common/TagBadge'
import { SESSION_COLORS } from '../../lib/sessionColors'

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
  onAddSession?: (folderId?: string) => void
  isCompact?: boolean
  activeSessionIds?: Set<string>
}

export function SessionList({ onQuickConnect, onEditSession, onAddSession, isCompact = false, activeSessionIds = new Set() }: SessionListProps) {
  const { sessions, folders, expandedFolders, toggleFolder, addFolder, updateFolder, removeFolder, removeSession, moveSessionToFolder, updateSession, saveToBackend, availableTags, activeTagFilter, filterByTag } = useSessionStore()
  const reducedMotion = useReducedMotion()
  const [showTagFilter, setShowTagFilter] = useState(false)
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
  }

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

  const handleDeleteFolder = () => {
    if (!contextMenu.targetId) return
    if (confirm('이 폴더를 삭제하시겠습니까? 하위 폴더도 함께 삭제됩니다.')) {
      removeFolder(contextMenu.targetId)
      saveToBackend()
    }
    setContextMenu(prev => ({ ...prev, visible: false }))
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

  const handleDeleteSession = () => {
    if (!contextMenu.targetId) return
    if (confirm('이 연결을 삭제하시겠습니까?')) {
      removeSession(contextMenu.targetId)
      saveToBackend()
    }
    setContextMenu(prev => ({ ...prev, visible: false }))
  }

  const handleMoveToFolder = (folderId: string | undefined) => {
    if (!contextMenu.targetId) return
    moveSessionToFolder(contextMenu.targetId, folderId)
    saveToBackend()
    setContextMenu(prev => ({ ...prev, visible: false }))
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

  // Filter sessions by active tag
  const filterSessionsByTag = (sessionList: Session[]) => {
    if (!activeTagFilter) return sessionList
    return sessionList.filter(s => s.tags?.includes(activeTagFilter))
  }

  // Get sessions for a folder
  const getSessionsInFolder = (folderId: string) => {
    return filterSessionsByTag(sessions.filter(s => s.folderId === folderId))
  }

  // Get root sessions (no folder)
  const getRootSessions = () => {
    return filterSessionsByTag(sessions.filter(s => !s.folderId))
  }

  // Get current session's folder for context menu
  const getCurrentSessionFolder = () => {
    if (!contextMenu.targetId) return undefined
    const session = sessions.find(s => s.id === contextMenu.targetId)
    return session?.folderId
  }

  // Render folder tree for move menu
  const renderFolderTreeMenu = (parentId?: string, depth: number = 0): JSX.Element[] => {
    const childFolders = getChildFolders(parentId)
    const currentFolderId = getCurrentSessionFolder()

    return childFolders.map(folder => {
      const isCurrentFolder = folder.id === currentFolderId
      const hasChildren = getChildFolders(folder.id).length > 0

      return (
        <div key={folder.id}>
          <div
            className={`context-menu-item ${isCurrentFolder ? 'current' : ''}`}
            style={{ paddingLeft: 12 + depth * 16 }}
            onClick={() => !isCurrentFolder && handleMoveToFolder(folder.id)}
          >
            <RiFolderFill size={14} />
            <span>{folder.name}</span>
            {isCurrentFolder && <span className="current-badge">현재</span>}
          </div>
          {hasChildren && renderFolderTreeMenu(folder.id, depth + 1)}
        </div>
      )
    })
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

    return (
      <div key={folder.id} className="session-folder">
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
            {isExpanded ? <RiArrowDownSFill size={14} /> : <RiArrowRightSFill size={14} />}
            <RiFolderFill size={14} />
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
          {(isExpanded || isCompact) && (
            <motion.div
              className={`folder-contents ${isDropTarget ? 'drop-target' : ''}`}
              variants={reducedMotion ? undefined : collapseVariants}
              initial="hidden"
              animate="visible"
              exit="hidden"
              onDragOver={(e) => handleFolderDragOver(e, folder.id)}
              onDrop={(e) => handleFolderDrop(e, folder.id)}
            >
              {childFolders.map(child => renderFolder(child, depth + 1))}
              {folderSessions.map(session => (
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
                  isActive={activeSessionIds.has(session.id)}
                  effectiveColor={getEffectiveColor(session)}
                />
              ))}
              {childFolders.length === 0 && folderSessions.length === 0 && (
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
        {!isCompact && (
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

  const activeTag = availableTags.find(t => t.id === activeTagFilter)

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
      {!isCompact && (
        <div className="tag-filter-bar">
          <button
            className={`tag-filter-toggle ${showTagFilter ? 'active' : ''}`}
            onClick={() => setShowTagFilter(!showTagFilter)}
            title="Filter by tag"
          >
            <RiFilterLine size={14} />
            {activeTag && <span className="active-filter-count">1</span>}
          </button>
          {showTagFilter && (
            <div className="tag-filter-dropdown">
              <div className="tag-filter-header">
                <span>Filter by tag</span>
                {activeTagFilter && (
                  <button
                    className="clear-filter"
                    onClick={() => filterByTag(null)}
                    title="Clear filter"
                  >
                    <RiCloseLine size={14} />
                  </button>
                )}
              </div>
              <div className="tag-filter-list">
                {availableTags.map(tag => (
                  <button
                    key={tag.id}
                    className={`tag-filter-item ${activeTagFilter === tag.id ? 'active' : ''}`}
                    onClick={() => filterByTag(tag.id === activeTagFilter ? null : tag.id)}
                  >
                    <TagBadge name={tag.name} color={tag.color} size="sm" />
                  </button>
                ))}
              </div>
            </div>
          )}
          {activeTag && (
            <div className="active-tag-filter">
              <TagBadge
                name={activeTag.name}
                color={activeTag.color}
                size="sm"
                onRemove={() => filterByTag(null)}
              />
            </div>
          )}
        </div>
      )}
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
            isActive={activeSessionIds.has(session.id)}
            effectiveColor={getEffectiveColor(session)}
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
            <RiCloseLine size={14} />
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
            <RiCloseLine size={14} />
            <span>취소</span>
          </div>
        </div>
      )}

      {/* Context Menu */}
      {contextMenu.visible && (
        <div
          className="context-menu"
          style={{ left: contextMenu.x, top: contextMenu.y }}
          onClick={(e) => e.stopPropagation()}
        >
          {contextMenu.type === 'folder' && (
            <>
              {onAddSession && (
                <div className="context-menu-item" onClick={handleAddSessionToFolder}>
                  <RiAddLine size={14} />
                  <span>세션 추가</span>
                </div>
              )}
              <div className="context-menu-item" onClick={handleAddSubfolder}>
                <RiFolderAddLine size={14} />
                <span>하위 폴더 추가</span>
              </div>
              <div className="context-menu-item" onClick={handleRenameFolder}>
                <RiEditLine size={14} />
                <span>이름 변경</span>
              </div>
              <div className="context-menu-item" onClick={handleChangeFolderColor}>
                <RiPaletteLine size={14} />
                <span>색상 변경</span>
              </div>
              <div className="context-menu-divider" />
              <div className="context-menu-item danger" onClick={handleDeleteFolder}>
                <RiDeleteBinLine size={14} />
                <span>삭제</span>
              </div>
            </>
          )}
          {contextMenu.type === 'session' && (
            <>
              <div className="context-menu-item" onClick={handleEditSession}>
                <RiEditLine size={14} />
                <span>수정</span>
              </div>
              <div className="context-menu-item" onClick={handleChangeSessionColor}>
                <RiPaletteLine size={14} />
                <span>색상 변경</span>
              </div>
              <div className="context-menu-divider" />
              <div className="context-menu-section-title">폴더로 이동</div>
              <div
                className={`context-menu-item ${!getCurrentSessionFolder() ? 'current' : ''}`}
                onClick={() => handleMoveToFolder(undefined)}
              >
                <RiFolderFill size={14} />
                <span>최상위</span>
                {!getCurrentSessionFolder() && <span className="current-badge">현재</span>}
              </div>
              {renderFolderTreeMenu()}
              <div className="context-menu-divider" />
              <div className="context-menu-item danger" onClick={handleDeleteSession}>
                <RiDeleteBinLine size={14} />
                <span>삭제</span>
              </div>
            </>
          )}
        </div>
      )}
    </div>
  )
}

interface SessionItemProps {
  session: Session
  onConnect: (session: Session) => void
  onContextMenu: (e: React.MouseEvent, sessionId: string) => void
  onDragStart: (e: React.DragEvent, type: 'session' | 'folder', id: string) => void
  onDragEnd: () => void
  isDragging: boolean
  isCompact: boolean
  reducedMotion: boolean
  isActive?: boolean
  effectiveColor?: string
}

function SessionItem({ session, onConnect, onContextMenu, onDragStart, onDragEnd, isDragging, isCompact, reducedMotion, isActive = false, effectiveColor }: SessionItemProps) {
  const iconId = session.icon as SessionIcon || 'server'
  const IconComponent = ICON_MAP[iconId] || RiServerFill
  const displayName = session.name || session.host
  const { availableTags } = useSessionStore()

  // Determine the highlight color: use session color if available, otherwise use CSS default
  const highlightColor = effectiveColor
  const itemStyle: React.CSSProperties = {}

  if (highlightColor) {
    itemStyle.borderLeft = `3px solid ${highlightColor}`
    itemStyle.background = `${highlightColor}20`
  }

  if (isActive && highlightColor) {
    // Override active state with session color
    itemStyle.background = `${highlightColor}30`
    itemStyle.borderLeft = `3px solid ${highlightColor}`
  }

  return (
    <motion.div
      className={`session-item ${isDragging ? 'dragging' : ''} ${isActive ? 'active' : ''} ${isActive && highlightColor ? 'active-custom-color' : ''}`}
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
      data-tooltip={isCompact ? displayName : undefined}
      whileHover={reducedMotion ? undefined : { x: 4 }}
      transition={{ duration: 0.15 }}
      style={Object.keys(itemStyle).length > 0 ? itemStyle : undefined}
    >
      <div className="session-item-icon">
        <IconComponent size={isCompact ? 20 : 14} />
        {isActive && <StatusIndicator status="connected" size="sm" />}
      </div>
      {!isCompact && (
        <>
          <span className="session-name">{displayName}</span>
          {session.tags && session.tags.length > 0 && (
            <div className="session-tags">
              {session.tags.map(tagId => {
                const tag = availableTags.find(t => t.id === tagId)
                return tag ? <TagBadge key={tagId} name={tag.name} color={tag.color} size="sm" /> : null
              })}
            </div>
          )}
        </>
      )}
    </motion.div>
  )
}
