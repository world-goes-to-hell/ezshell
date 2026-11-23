import { useState, useRef, useEffect, useLayoutEffect, useMemo } from 'react'
import { createPortal } from 'react-dom'
import { motion, AnimatePresence } from 'framer-motion'
import { useSessionStore, Folder, Session } from '../../stores/sessionStore'
import type { SessionTabGroup } from '../../lib/sessionTabs'
import { RiArrowDownSFill, RiArrowRightSFill, RiDeleteBinLine, RiEditLine, RiFolderAddLine, RiCloseLine, RiPaletteLine, RiAddLine, RiFileCopyLine, RiPlugLine, RiCheckLine, RiShareLine, RiKey2Line, RiClipboardLine } from 'react-icons/ri'
import { collapseVariants } from '../../lib/animation/variants'
import { useReducedMotion } from '../../hooks/useReducedMotion'
import { MoveToFolderSubmenu } from './MoveToFolderSubmenu'
import { SessionItem } from './SessionItem'
import { getDropPosition, type DropPosition } from '../../lib/sessionOrder'
import { getFolderPath } from '../../lib/folderPath'
import { confirmDialog } from '../../stores/confirmStore'
import { placeContextMenu } from '../../lib/sidePanelPlacement'
import { SESSION_COLORS } from '../../lib/sessionColors'
import { buildShareText, buildFolderShareText, ShareTooLargeError } from '../../lib/sessionShare'
import { toast } from '../../stores/toastStore'
import { SharePassphraseDialog } from './SharePassphraseDialog'
import { LinkToProjectSubmenu } from './LinkToProjectSubmenu'
import { matchName, type NamePart } from '../../lib/containerSearch'
import type { SessionSearchResult } from '../../lib/sessionSearch'

const TREE_ROW = '[role="treeitem"]'

function parentFolderRow(row: HTMLElement): HTMLElement | null {
  const parent = row.closest('.folder-contents')?.previousElementSibling
  return parent instanceof HTMLElement ? parent : null
}

function isVisibleTreeRow(row: HTMLElement): boolean {
  // Framer Motion keeps the closing group's rows in the DOM during the exit animation.
  for (let parent = parentFolderRow(row); parent; parent = parentFolderRow(parent)) {
    if (parent.getAttribute('aria-expanded') === 'false') return false
  }
  return true
}

interface ContextMenuState {
  visible: boolean
  x: number
  y: number
  type: 'root' | 'folder' | 'session' | null
  targetId: string | null
}

interface DragState {
  type: 'session' | 'folder' | null
  id: string | null
}

/** The sidebar search: marks matches without hiding anything */
export interface SessionListSearch {
  terms: string[]
  result: SessionSearchResult
  /** The match Enter connects to; scrolled into view */
  currentId?: string
}

const NO_SEARCH: SessionListSearch = { terms: [], result: { matchIds: [], openFolderIds: new Set() } }

/** Name with the searched words marked */
function MarkedName({ text, parts }: { text: string; parts: NamePart[] | null }) {
  if (!parts) return <>{text}</>
  return <>{parts.map((part, i) => (part.isMatch ? <mark key={i} className="sidebar-search-mark">{part.text}</mark> : <span key={i}>{part.text}</span>))}</>
}

interface SessionListProps {
  tabsBySession: ReadonlyMap<string, SessionTabGroup>
  search?: SessionListSearch
  onQuickConnect: (session: Session, source?: HTMLElement) => void
  onEditSession?: (session: Session) => void
  onDuplicateSession?: (session: Session) => void
  onAddFolder: () => void
  onAddSession?: (folderId?: string) => void
  /** Opens the paste dialog for session text, adding into the given folder */
  onImportSession?: (folderId?: string) => void
}

export function SessionList({ tabsBySession, search = NO_SEARCH, onQuickConnect, onEditSession, onDuplicateSession, onAddFolder, onAddSession, onImportSession }: SessionListProps) {
  const { sessions, folders, expandedFolders, toggleFolder, addFolder, updateFolder, removeFolder, removeSession, moveSessionToFolder, reorderSession, updateSession, saveToBackend } = useSessionStore()
  const reducedMotion = useReducedMotion()
  const [colorPickerFolderId, setColorPickerFolderId] = useState<string | null>(null)
  const [colorPickerSessionId, setColorPickerSessionId] = useState<string | null>(null)
  const listRef = useRef<HTMLDivElement>(null)

  // While searching, the folders holding a match are shown open without touching the stored state.
  // A folder the user closes during the search stays closed until the words change.
  const matchIds = useMemo(() => new Set(search.result.matchIds), [search.result])
  const [closedWhileSearching, setClosedWhileSearching] = useState<ReadonlySet<string>>(new Set())
  const searchKey = search.terms.join(' ')
  useEffect(() => { setClosedWhileSearching(new Set()) }, [searchKey])
  const isFolderOpen = (folderId: string) => expandedFolders.has(folderId)
    || (search.result.openFolderIds.has(folderId) && !closedWhileSearching.has(folderId))
  const toggleFolderView = (folderId: string) => {
    if (!search.result.openFolderIds.has(folderId)) {
      toggleFolder(folderId)
      return
    }
    const shown = isFolderOpen(folderId)
    if (expandedFolders.has(folderId)) toggleFolder(folderId)
    setClosedWhileSearching(prev => {
      const next = new Set(prev)
      if (shown) next.add(folderId)
      else next.delete(folderId)
      return next
    })
  }

  // Bring the current match into view (after a folder that just opened has room for it)
  useEffect(() => {
    const id = search.currentId
    if (!id) return
    const reveal = () => listRef.current
      ?.querySelector<HTMLElement>(`.session-item[data-session-id="${CSS.escape(id)}"]`)
      ?.scrollIntoView({ block: 'nearest' })
    reveal()
    const later = window.setTimeout(reveal, 260)
    return () => window.clearTimeout(later)
  }, [search.currentId, searchKey])

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

  // Dismiss the menu on an outside click or Escape.
  useEffect(() => {
    if (!contextMenu.visible) return
    const closeMenu = () => setContextMenu(prev => ({ ...prev, visible: false }))
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') closeMenu()
    }
    document.addEventListener('click', closeMenu)
    document.addEventListener('keydown', handleKeyDown)
    return () => {
      document.removeEventListener('click', closeMenu)
      document.removeEventListener('keydown', handleKeyDown)
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

  const handleBackgroundContextMenu = (e: React.MouseEvent<HTMLDivElement>) => {
    const target = e.target
    if (e.defaultPrevented || !(target instanceof Element)
      || !e.currentTarget.contains(target) || target.closest('.context-menu')) return
    e.preventDefault()
    e.stopPropagation()
    setContextMenu({ visible: true, x: e.clientX, y: e.clientY, type: 'root', targetId: null })
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

  const handleAddSession = () => {
    onAddSession?.(contextMenu.targetId ?? undefined)
    setContextMenu(prev => ({ ...prev, visible: false }))
  }

  const handleAddRootFolder = () => {
    onAddFolder()
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

  // Connection info as text for a messenger. A folder carries every sub-folder and session under it.
  // Passwords go only sealed with a shared passphrase the user picks in SharePassphraseDialog.
  const [shareTarget, setShareTarget] = useState<{ type: 'session' | 'folder'; id: string } | null>(null)

  const shareTextFor = async (target: { type: 'session' | 'folder'; id: string }, passphrase?: string): Promise<string | null> => {
    if (target.type === 'session') {
      const session = sessions.find(s => s.id === target.id)
      return session ? buildShareText(session, { passphrase }) : null
    }
    return buildFolderShareText(target.id, folders, sessions, { passphrase })
  }

  const copyShareText = async (target: { type: 'session' | 'folder'; id: string }, passphrase?: string): Promise<void> => {
    let text: string | null
    try {
      text = await shareTextFor(target, passphrase)
    } catch (error) {
      toast.error('복사하지 못했습니다', error instanceof ShareTooLargeError ? error.message : '연결 정보를 만들지 못했습니다')
      return
    }
    if (!text) {
      toast.error('복사하지 못했습니다', '세션이나 폴더가 그 사이 지워졌습니다')
      return
    }
    try {
      await navigator.clipboard.writeText(text)
    } catch {
      toast.error('복사하지 못했습니다', '클립보드를 쓸 수 없습니다')
      return
    }
    const sealed = text.split('\n')[1]?.includes('.') === true
    // Start-up scripts always travel in plain text, passwords or not
    const scriptNote = sharesScript(target) ? ' 자동 실행 스크립트는 그대로 들어가니, 스크립트에 비밀번호나 토큰이 있다면 지우고 보내세요.' : ''
    toast.success('연결 정보를 복사했습니다', (sealed
      ? '비밀번호는 공유 암호로 암호화되어 있습니다. 공유 암호는 전화 등 다른 방법으로 알려 주세요.'
      : '비밀번호는 빠져 있습니다. 받은 사람은 사이드바의 "텍스트로 세션 추가" 로 넣습니다.') + scriptNote)
  }

  /** Whether any session that goes into the text has a start-up script */
  const sharesScript = (target: { type: 'session' | 'folder'; id: string }): boolean => {
    if (target.type === 'session') return Boolean(sessions.find(s => s.id === target.id)?.postConnectScript?.trim())
    const inside = new Set([target.id])
    let grew = true
    while (grew) {
      grew = false
      for (const f of folders) {
        if (f.parentId && inside.has(f.parentId) && !inside.has(f.id)) { inside.add(f.id); grew = true }
      }
    }
    return sessions.some(s => s.folderId !== undefined && inside.has(s.folderId) && Boolean(s.postConnectScript?.trim()))
  }

  const handleCopyShareText = (includeSecrets: boolean) => {
    const { type, targetId } = contextMenu
    setContextMenu(prev => ({ ...prev, visible: false }))
    if (!targetId || (type !== 'session' && type !== 'folder')) return
    const target = { type, id: targetId }
    if (includeSecrets) setShareTarget(target)
    else void copyShareText(target)
  }

  const shareSubject = (target: { type: 'session' | 'folder'; id: string }): string => {
    if (target.type === 'session') {
      const session = sessions.find(s => s.id === target.id)
      return `"${session?.name || session?.host || '이'}" 세션`
    }
    return `"${getFolderPath(folders, target.id)}" 폴더 안 모든 세션`
  }

  const handleImportToFolder = () => {
    if (contextMenu.targetId && onImportSession) onImportSession(contextMenu.targetId)
    setContextMenu(prev => ({ ...prev, visible: false }))
  }

  // Same flag as the checkbox in the edit dialog's advanced settings. Saving goes through
  // save-sessions, so main drops this session's MCP connection and jobs when it is turned off.
  const handleToggleMcpAccess = () => {
    const session = sessions.find(s => s.id === contextMenu.targetId)
    setContextMenu(prev => ({ ...prev, visible: false }))
    if (!session) return
    updateSession(session.id, { mcpEnabled: session.mcpEnabled !== true })
    saveToBackend()
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

  const isMcpAllowedForMenuTarget = contextMenu.type === 'session'
    && sessions.find(s => s.id === contextMenu.targetId)?.mcpEnabled === true

  const handleTreeKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    const row = event.target
    if (!(row instanceof HTMLElement) || !row.matches(TREE_ROW)
      || !event.currentTarget.contains(row) || event.nativeEvent.isComposing
      || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return

    const folderId = row.dataset.folderId
    const expanded = row.getAttribute('aria-expanded') === 'true'
    let next: HTMLElement | null | undefined
    switch (event.key) {
      case 'Enter':
      case ' ':
        if (folderId) {
          if (!event.repeat) toggleFolderView(folderId)
        } else if (event.key === 'Enter') {
          const session = sessions.find(item => item.id === row.dataset.sessionId)
          if (session && !event.repeat) onQuickConnect(session, row)
        } else return
        break
      case 'ArrowRight':
        if (folderId && !expanded) toggleFolderView(folderId)
        else if (folderId) next = row.nextElementSibling?.querySelector<HTMLElement>(TREE_ROW)
        break
      case 'ArrowLeft':
        if (folderId && expanded) toggleFolderView(folderId)
        else next = parentFolderRow(row)
        break
      case 'ArrowDown':
      case 'ArrowUp':
      case 'Home':
      case 'End': {
        const rows = Array.from(event.currentTarget.querySelectorAll<HTMLElement>(TREE_ROW)).filter(isVisibleTreeRow)
        const index = rows.indexOf(row)
        if (event.key === 'Home') next = rows[0]
        else if (event.key === 'End') next = rows[rows.length - 1]
        else next = rows[index + (event.key === 'ArrowDown' ? 1 : -1)]
        break
      }
      default:
        return
    }
    event.preventDefault()
    event.stopPropagation()
    next?.focus()
  }

  const searchProps = (session: Session) => {
    const isMatch = matchIds.has(session.id)
    return {
      isMatch,
      isCurrentMatch: isMatch && search.currentId === session.id,
      nameParts: isMatch ? matchName(session.name || session.host, search.terms) : null
    }
  }

  // Sessions in a folder and every folder under it (a closed folder's count)
  const countSessionsDeep = (folderId: string, seen: Set<string> = new Set()): number => {
    if (seen.has(folderId)) return 0
    seen.add(folderId)
    return getSessionsInFolder(folderId).length +
      getChildFolders(folderId).reduce((sum, child) => sum + countSessionsDeep(child.id, seen), 0)
  }

  // Recursive folder renderer
  const renderFolder = (folder: Folder, depth: number = 0) => {
    const isExpanded = isFolderOpen(folder.id)
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
        tabs={tabsBySession.get(session.id)}
        {...sessionItemDropProps(session.id)}
        {...searchProps(session)}
      />
    ))

    return (
      // A folder with a colour of its own draws one thin line down its left side; rows carry no fill
      <div
        key={folder.id}
        className={`session-folder ${depth === 0 ? 'is-top' : 'is-nested'} ${folder.backgroundColor ? 'has-own-color' : ''}`}
        style={folderEffectiveColor ? { '--folder-color': folderEffectiveColor } as React.CSSProperties : undefined}
      >
        <div
          className={`folder-header ${isDragging ? 'dragging' : ''} ${isDropTarget ? 'drop-target' : ''}`}
          data-folder-id={folder.id}
          role="treeitem"
          aria-expanded={isExpanded}
          aria-label={`폴더: ${folder.name}`}
          aria-owns={isExpanded ? `session-folder-contents-${folder.id}` : undefined}
          tabIndex={0}
          onClick={() => toggleFolderView(folder.id)}
          onContextMenu={(e) => handleFolderContextMenu(e, folder.id)}
          draggable={!isEditing}
          onDragStart={(e) => handleDragStart(e, 'folder', folder.id)}
          onDragEnd={handleDragEnd}
          onDragOver={(e) => handleFolderDragOver(e, folder.id)}
          onDragLeave={handleFolderDragLeave}
          onDrop={(e) => handleFolderDrop(e, folder.id)}
        >
          {isExpanded ? <RiArrowDownSFill size={14} className="folder-chevron" /> : <RiArrowRightSFill size={14} className="folder-chevron" />}
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
            <span className="folder-name"><MarkedName text={folder.name} parts={matchName(folder.name, search.terms)} /></span>
          )}
          {/* How many sessions a closed folder holds, those in its sub-folders included */}
          {!isExpanded && !isEditing && (() => {
            const total = countSessionsDeep(folder.id)
            if (total === 0) return null
            const nested = total - folderSessions.length
            return (
              <span className="folder-count" title={`세션 ${total}개${nested > 0 ? ` (하위 폴더 안 ${nested}개 포함)` : ''}`}>
                {total}
              </span>
            )
          })()}
        </div>
        <AnimatePresence initial={false}>
          {isExpanded && (
            <motion.div
              className={`folder-contents ${isDropTarget ? 'drop-target' : ''}`}
              id={`session-folder-contents-${folder.id}`}
              role="group"
              variants={reducedMotion ? undefined : collapseVariants}
              initial="hidden"
              animate="visible"
              exit="hidden"
              onDragOver={(e) => handleFolderDragOver(e, folder.id)}
              onDrop={(e) => handleFolderDrop(e, folder.id)}
            >
              {childFolders.map(child => renderFolder(child, depth + 1))}
              {sessionItems}
              {childFolders.length === 0 && folderSessions.length === 0 && (
                <div className="folder-empty-drop-zone">폴더가 비어 있습니다</div>
              )}
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    )
  }

  const isEmpty = sessions.length === 0 && folders.length === 0
  const rootFolders = getChildFolders(undefined)
  const rootSessions = getRootSessions()
  const isRootDropTarget = dropTargetId === 'root'

  return (
    <div
      ref={listRef}
      className={isEmpty ? 'session-list-empty' : 'session-list'}
      role={isEmpty ? undefined : 'tree'}
      aria-label={isEmpty ? undefined : 'SSH 세션 목록'}
      onKeyDown={handleTreeKeyDown}
      onContextMenu={handleBackgroundContextMenu}
      onDragOver={(e) => {
        if (isEmpty) return
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
      onDrop={isEmpty ? undefined : handleRootDrop}
    >
      {isEmpty ? (
        <>
          <p>저장된 연결이 없습니다</p>
          <p className="text-muted">새 연결을 추가해주세요</p>
        </>
      ) : (
        <>
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
                tabs={tabsBySession.get(session.id)}
                {...sessionItemDropProps(session.id)}
                {...searchProps(session)}
              />
            ))}
          </div>
        </>
      )}

      {/* Folder Color Picker Modal */}
      {colorPickerFolderId && createPortal(
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
            <label className="color-option color-option-custom" title="직접 선택">
              <input
                type="color"
                defaultValue={folders.find(f => f.id === colorPickerFolderId)?.backgroundColor || '#3fb950'}
                onChange={(e) => handleSelectFolderColor(e.target.value)}
              />
            </label>
          </div>
          <div className="context-menu-divider" />
          <div className="context-menu-item" onClick={() => setColorPickerFolderId(null)}>
            <RiCloseLine size={16} />
            <span>취소</span>
          </div>
        </div>,
        document.body
      )}

      {/* Session Color Picker Modal */}
      {colorPickerSessionId && createPortal(
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
            <label className="color-option color-option-custom" title="직접 선택">
              <input
                type="color"
                defaultValue={sessions.find(s => s.id === colorPickerSessionId)?.backgroundColor || '#3fb950'}
                onChange={(e) => handleSelectSessionColor(e.target.value)}
              />
            </label>
          </div>
          <div className="context-menu-divider" />
          <div className="context-menu-item" onClick={() => setColorPickerSessionId(null)}>
            <RiCloseLine size={16} />
            <span>취소</span>
          </div>
        </div>,
        document.body
      )}

      {/* The Glass sidebar's backdrop filter contains fixed descendants and clips them to the panel. */}
      {contextMenu.visible && createPortal(
        <div
          ref={contextMenuRef}
          className="context-menu session-context-menu"
          style={contextMenuPosition
            ? { left: contextMenuPosition.x, top: contextMenuPosition.y }
            : { left: contextMenu.x, top: contextMenu.y, visibility: 'hidden' }}
          onClick={(e) => e.stopPropagation()}
        >
          {contextMenu.type === 'root' && (
            <div className="context-menu-item" onClick={handleAddRootFolder}>
              <RiFolderAddLine size={16} />
              <span>폴더 추가</span>
            </div>
          )}
          {(contextMenu.type === 'root' || contextMenu.type === 'folder') && onAddSession && (
            <div className="context-menu-item" onClick={handleAddSession}>
              <RiAddLine size={16} />
              <span>세션 추가</span>
            </div>
          )}
          {contextMenu.type === 'folder' && (
            <>
              {onImportSession && (
                <div className="context-menu-item" onClick={handleImportToFolder}>
                  <RiClipboardLine size={16} />
                  <span>텍스트로 세션 추가</span>
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
              <div className="context-menu-item" onClick={() => handleCopyShareText(false)}>
                <RiShareLine size={16} />
                <span>폴더 연결 정보 복사</span>
              </div>
              <div className="context-menu-item" onClick={() => handleCopyShareText(true)}>
                <RiKey2Line size={16} />
                <span>비밀번호 포함 복사…</span>
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
              <div className="context-menu-item" onClick={() => handleCopyShareText(false)}>
                <RiShareLine size={16} />
                <span>연결 정보 복사</span>
              </div>
              <div className="context-menu-item" onClick={() => handleCopyShareText(true)}>
                <RiKey2Line size={16} />
                <span>비밀번호 포함 복사…</span>
              </div>
              <div className="context-menu-item" onClick={handleChangeSessionColor}>
                <RiPaletteLine size={16} />
                <span>색상 변경</span>
              </div>
              <MoveToFolderSubmenu
                folders={folders}
                currentFolderId={getCurrentSessionFolder()}
                onMove={handleMoveToFolder}
              />
              {contextMenu.targetId && <LinkToProjectSubmenu sessionId={contextMenu.targetId} />}
              <div className="context-menu-divider" />
              <div
                className="context-menu-item"
                role="menuitemcheckbox"
                aria-checked={isMcpAllowedForMenuTarget}
                onClick={handleToggleMcpAccess}
              >
                <RiPlugLine size={16} />
                <span>MCP 접근 허용</span>
                {isMcpAllowedForMenuTarget && <RiCheckLine size={16} className="context-menu-check" />}
              </div>
              <div className="context-menu-divider" />
              <div className="context-menu-item danger" onClick={handleDeleteSession}>
                <RiDeleteBinLine size={16} />
                <span>삭제</span>
              </div>
            </>
          )}
        </div>,
        document.body
      )}
      {shareTarget && (
        <SharePassphraseDialog
          subject={shareSubject(shareTarget)}
          onCancel={() => setShareTarget(null)}
          onConfirm={async (passphrase) => {
            await copyShareText(shareTarget, passphrase)
            setShareTarget(null)
          }}
        />
      )}
    </div>
  )
}
