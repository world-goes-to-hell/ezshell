import { useState, useRef, useEffect, useMemo } from 'react'
import { useSftpStore, FileItem } from '../../stores/sftpStore'
import { useWheelRowScroll } from '../../hooks/useWheelRowScroll'
import { useDirectoryHistory } from '../../hooks/useDirectoryHistory'
import { resolveFileListShortcut, type FileListShortcut } from '../../lib/fileListShortcuts'
import { validateNewName } from '../../lib/fileNameValidation'
import { isWindowsPath, nextFolderName, parentPath, joinChildPath } from '../../lib/sftpFileOps'
import { useFolderDropTargets, FILE_LIST_DRAG_TYPE } from '../../hooks/useFolderDropTargets'
import { sortFileItems, nextSort, DEFAULT_SORT, type FileSort, type FileSortKey } from '../../lib/fileSort'
import { RiFolderFill, RiArrowUpSFill } from 'react-icons/ri'
import { InlineNameInput } from './InlineNameInput'
import { FileListHeader } from './FileListHeader'
import { getFileIcon } from './fileIcons'
import { TransferMarkBadge, transferMarkClass } from './TransferMarkBadge'
import { transferMarksFor } from '../../lib/transferMarks'
import './FileList.css'
import {
  FileListContextMenu, buildContextMenuItems, CONTEXT_MENU_ITEM_HEIGHT, CONTEXT_MENU_WIDTH,
  type ContextMenuAction
} from './FileListContextMenu'

interface FileListProps {
  files: FileItem[]
  selected: Set<string>
  onNavigate: (path: string) => void
  currentPath: string
  type: 'local' | 'remote'
  sessionId: string
  onUpload?: () => void
  onDownload?: () => void
  /** Delete the selection (remote: permanent, local: Recycle Bin). Hidden when not provided. */
  onDelete?: () => void
  /** Rename an entry in the current folder; resolve true once the listing is refreshed */
  onRename?: (oldName: string, newName: string) => Promise<boolean>
  /** Create a folder in the current folder; resolve true once the listing is refreshed */
  onCreateFolder?: (name: string) => Promise<boolean>
  /** Ctrl+L: move focus to this pane's path bar */
  onFocusPath?: () => void
  /** Entries dropped from the other list: into `targetDir` when dropped on a folder row, else the current folder */
  onDrop?: (fileNames: string[], targetDir?: string) => void
  /** Entries of this list dropped on one of its folder rows or ".." (asks, then moves) */
  onMoveInto?: (names: string[], targetDir: string) => void
  isLoading?: boolean
}

interface ContextMenuState {
  visible: boolean
  x: number
  y: number
  file: FileItem | null
}

type EditState = { mode: 'rename'; name: string } | { mode: 'create'; initialName: string }

const KEEP_SELECTION_ATTR = 'data-sftp-keep-selection'
const CONTEXT_MENU_EDGE_GAP = 10

/** Spread onto containers whose controls act on the current selection (e.g. the SFTP toolbar). */
export const keepSelectionProps = { [KEEP_SELECTION_ATTR]: '' }

// Drop-target key of the ".." row (entry names never contain a slash)
const PARENT_ROW_KEY = '/..'

export function FileList({
  files: rawFiles, selected, onNavigate, currentPath, type, sessionId,
  onUpload, onDownload, onDelete, onRename, onCreateFolder, onFocusPath, onDrop, onMoveInto, isLoading
}: FileListProps) {
  const store = useSftpStore()
  // Kept while the panel stays open (this component stays mounted across folder changes)
  const [sort, setSort] = useState<FileSort>(DEFAULT_SORT)
  const files = useMemo(() => sortFileItems(rawFiles, sort), [rawFiles, sort])
  // Files this session uploaded (remote list) / downloaded (local list) into the folder on screen
  const transfers = store.transfers(sessionId)
  const transferMarks = useMemo(() => transferMarksFor(transfers, type, currentPath), [transfers, type, currentPath])
  const [contextMenu, setContextMenu] = useState<ContextMenuState>({ visible: false, x: 0, y: 0, file: null })
  const contextMenuRef = useRef<HTMLDivElement>(null)
  const fileListRef = useRef<HTMLDivElement>(null)
  // One wheel notch scrolls 2 rows instead of the browser's ~4
  useWheelRowScroll(fileListRef, '.file-item')
  // Mouse thumb buttons (and Alt+Left / Alt+Right): back / forward through visited directories
  const stepHistory = useDirectoryHistory(fileListRef, currentPath, !!isLoading, onNavigate)
  const itemRefs = useRef<(HTMLDivElement | null)[]>([])
  const [isDragOver, setIsDragOver] = useState(false)
  const folderDrop = useFolderDropTargets({
    type, sessionId, dirPath: currentPath, onMoveInto, onTransferInto: onDrop,
    onRowActivity: () => setIsDragOver(false)
  })
  const [lastSelectedIndex, setLastSelectedIndex] = useState<number>(-1)
  const [editing, setEditing] = useState<EditState | null>(null)
  // Entry to select once the refreshed listing arrives (after rename / new folder)
  const revealNameRef = useRef<string | null>(null)
  const focusIndexRef = useRef<number>(-1)
  const [, forceUpdate] = useState(0)
  const focusIndex = focusIndexRef.current
  const setFocusIndex = (idx: number) => {
    focusIndexRef.current = idx
    forceUpdate(c => c + 1)
  }

  const selectOnly = (name: string) => {
    if (type === 'remote') {
      store.setRemoteSelection(sessionId, name)
    } else {
      store.setLocalSelection(sessionId, name)
    }
  }

  const clearSelection = () => {
    if (type === 'remote') {
      store.clearRemoteSelection(sessionId)
    } else {
      store.clearLocalSelection(sessionId)
    }
  }

  const setMultiSelection = (names: string[]) => {
    if (type === 'remote') {
      store.setRemoteMultiSelection(sessionId, names)
    } else {
      store.setLocalMultiSelection(sessionId, names)
    }
  }

  // Close context menu on click outside
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (contextMenuRef.current && !contextMenuRef.current.contains(e.target as Node)) {
        setContextMenu(prev => ({ ...prev, visible: false }))
      }
    }
    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [])

  useEffect(() => {
    const name = revealNameRef.current
    revealNameRef.current = null
    const index = name ? files.findIndex(f => f.name === name) : -1
    if (index < 0) {
      setFocusIndex(-1)
      return
    }
    selectOnly(files[index].name)
    setLastSelectedIndex(index)
    setFocusIndex(index)
    itemRefs.current[index]?.scrollIntoView({ block: 'nearest' })
    // New listing only: re-sorting keeps selection and is handled in handleSort
  }, [rawFiles])

  // Navigating away abandons an unfinished rename / new folder
  useEffect(() => {
    setEditing(null)
  }, [currentPath])

  const focusList = () => fileListRef.current?.focus()

  // Handles every drive root ("D:\"), not only "C:\"
  const childPath = (name: string) => joinChildPath(currentPath, name, type)

  const openDirectory = (file: FileItem) => {
    if (file.type !== 'directory') return false
    onNavigate(childPath(file.name))
    return true
  }

  const selectIndex = (index: number) => {
    if (index < 0 || index >= files.length) return
    selectOnly(files[index].name)
    setLastSelectedIndex(index)
    setFocusIndex(index)
    itemRefs.current[index]?.scrollIntoView({ block: 'nearest' })
  }

  // F2 renames the focused entry, like Explorer; otherwise the most recently selected one
  const renameTarget = (): FileItem | null => {
    const candidates = [focusIndex, lastSelectedIndex]
      .filter(index => index >= 0 && index < files.length && selected.has(files[index].name))
      .map(index => files[index])
    return candidates[0] ?? files.find(file => selected.has(file.name)) ?? null
  }

  const startRename = (file: FileItem | null) => {
    if (!onRename || !file) return
    setEditing({ mode: 'rename', name: file.name })
  }

  const startCreateFolder = () => {
    if (!onCreateFolder) return
    setEditing({ mode: 'create', initialName: nextFolderName(files.map(f => f.name)) })
    fileListRef.current?.scrollTo({ top: 0 })
  }

  const finishEditing = () => {
    setEditing(null)
    focusList()
  }

  const validate = (value: string, currentName?: string) => validateNewName(value, {
    windowsRules: type === 'local' && isWindowsPath(currentPath),
    existingNames: files.map(f => f.name),
    currentName
  })

  const commitRename = async (oldName: string, value: string): Promise<string | null> => {
    const result = validate(value, oldName)
    if (!result.ok) return result.error
    if (result.name === oldName) {
      finishEditing()
      return null
    }
    revealNameRef.current = result.name
    const renamed = await onRename!(oldName, result.name)
    if (!renamed) revealNameRef.current = null
    finishEditing()
    return null
  }

  const commitCreateFolder = async (value: string): Promise<string | null> => {
    const result = validate(value)
    if (!result.ok) return result.error
    revealNameRef.current = result.name
    const created = await onCreateFolder!(result.name)
    if (!created) revealNameRef.current = null
    finishEditing()
    return null
  }

  // Parent of the current folder; null at a drive or filesystem root
  const parentDir = parentPath(currentPath, type)

  const goUp = () => {
    if (parentDir) onNavigate(parentDir)
  }

  // Row indexes change with the order, so carry the range anchor and keyboard focus over by name
  const handleSort = (key: FileSortKey) => {
    const next = nextSort(sort, key)
    const reordered = sortFileItems(rawFiles, next)
    const indexIn = (index: number) => (index >= 0 && index < files.length
      ? reordered.findIndex(f => f.name === files[index].name)
      : -1)
    setLastSelectedIndex(indexIn(lastSelectedIndex))
    setSort(next)
    setFocusIndex(indexIn(focusIndex))
  }

  const runShortcut = (shortcut: FileListShortcut) => {
    switch (shortcut) {
      case 'rename': return startRename(renameTarget())
      case 'delete': return selected.size > 0 ? onDelete?.() : undefined
      case 'newFolder': return startCreateFolder()
      case 'refresh': return onNavigate(currentPath)
      case 'back': return stepHistory('back')
      case 'forward': return stepHistory('forward')
      case 'up': return goUp()
      case 'first': return selectIndex(0)
      case 'last': return selectIndex(files.length - 1)
      case 'clearSelection':
        clearSelection()
        return setFocusIndex(-1)
      case 'focusPath': return onFocusPath?.()
      case 'selectAll':
        return type === 'remote' ? store.selectAllRemote(sessionId) : store.selectAllLocal(sessionId)
      case 'swallow': return
    }
  }

  const moveFocus = (e: React.KeyboardEvent, delta: 1 | -1) => {
    e.preventDefault()
    const fallbackStart = delta === 1
      ? (lastSelectedIndex >= 0 ? lastSelectedIndex - 1 : -1)
      : (lastSelectedIndex >= 0 ? lastSelectedIndex + 1 : files.length)
    const startFrom = focusIndex >= 0 ? focusIndex : fallbackStart
    const nextIndex = Math.min(Math.max(startFrom + delta, 0), files.length - 1)
    setFocusIndex(nextIndex)
    if (e.shiftKey) {
      // Shift+Arrow: extend range selection
      const anchor = lastSelectedIndex >= 0 ? lastSelectedIndex : nextIndex
      setMultiSelection(files.slice(Math.min(anchor, nextIndex), Math.max(anchor, nextIndex) + 1).map(f => f.name))
    } else {
      selectOnly(files[nextIndex].name)
      setLastSelectedIndex(nextIndex)
    }
    itemRefs.current[nextIndex]?.scrollIntoView({ block: 'nearest' })
  }

  const handleListKeyDown = (e: React.KeyboardEvent) => {
    // Esc closes an open context menu before it clears the selection, like Explorer
    if (contextMenu.visible) {
      if (e.key === 'Escape') {
        e.preventDefault()
        e.stopPropagation()
        setContextMenu(prev => ({ ...prev, visible: false }))
      }
      return
    }
    const shortcut = resolveFileListShortcut(e)
    if (shortcut) {
      // Keep app-wide shortcuts (lock, close tab, terminal search, double-Esc zen mode) from also firing
      e.preventDefault()
      e.stopPropagation()
      if (!isLoading && !editing) runShortcut(shortcut)
      return
    }
    if (isLoading || editing) return

    if (e.key === 'ArrowDown') {
      moveFocus(e, 1)
    } else if (e.key === 'ArrowUp') {
      moveFocus(e, -1)
    } else if (e.key === 'ArrowRight' || e.key === 'Enter') {
      const file = focusIndex >= 0 && focusIndex < files.length ? files[focusIndex] : null
      if (e.key === 'Enter') e.preventDefault()
      if (file && openDirectory(file)) {
        e.preventDefault()
        setFocusIndex(-1)
      }
    } else if (e.key === 'ArrowLeft' || e.key === 'Backspace') {
      e.preventDefault()
      goUp()
      setFocusIndex(-1)
    }
  }

  const handleBlur = (e: React.FocusEvent) => {
    if (e.currentTarget.contains(e.relatedTarget as Node)) return
    // Toolbar buttons (upload/download) act on the selection. Clicking one moves focus
    // to the button, so clearing here would empty the selection before its onClick runs.
    const next = e.relatedTarget as HTMLElement | null
    if (next?.closest(`[${KEEP_SELECTION_ATTR}]`)) return
    clearSelection()
    setFocusIndex(-1)
  }

  const handleClick = (e: React.MouseEvent, file: FileItem, index: number) => {
    // Focus the file list so keyboard shortcuts work
    focusList()
    if (e.ctrlKey || e.metaKey) {
      // Ctrl+click: toggle selection (multi-select)
      if (type === 'remote') {
        store.toggleRemoteSelection(sessionId, file.name)
      } else {
        store.toggleLocalSelection(sessionId, file.name)
      }
      setLastSelectedIndex(index)
    } else if (e.shiftKey && lastSelectedIndex >= 0) {
      // Shift+click: range selection
      const start = Math.min(lastSelectedIndex, index)
      const end = Math.max(lastSelectedIndex, index)
      setMultiSelection(files.slice(start, end + 1).map(f => f.name))
    } else {
      selectOnly(file.name)
      setLastSelectedIndex(index)
    }
    // Drop a stale keyboard focus so F2 / arrows continue from the clicked row
    setFocusIndex(-1)
  }

  const openContextMenu = (e: React.MouseEvent, file: FileItem | null) => {
    e.preventDefault()
    e.stopPropagation()
    if (editing) return
    focusList()

    // Select the file if not already selected
    if (file && !selected.has(file.name)) selectOnly(file.name)

    const itemCount = buildContextMenuItems({
      file, type, canRename: Boolean(onRename), canCreateFolder: Boolean(onCreateFolder), canDelete: Boolean(onDelete)
    }).length
    const menuHeight = itemCount * CONTEXT_MENU_ITEM_HEIGHT + 24
    const x = Math.min(e.clientX, window.innerWidth - CONTEXT_MENU_WIDTH - CONTEXT_MENU_EDGE_GAP)
    const y = Math.min(e.clientY, window.innerHeight - menuHeight - CONTEXT_MENU_EDGE_GAP)
    setContextMenu({ visible: true, x, y, file })
  }

  const handleDoubleClick = (file: FileItem) => {
    openDirectory(file)
  }

  const formatSize = (bytes: number) => {
    if (bytes < 1024) return `${bytes} B`
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
    if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
    return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`
  }

  const formatDate = (timestamp: number) => {
    if (!timestamp) return ''
    const d = new Date(timestamp)
    const now = new Date()
    const isThisYear = d.getFullYear() === now.getFullYear()
    const month = String(d.getMonth() + 1).padStart(2, '0')
    const day = String(d.getDate()).padStart(2, '0')
    const hours = String(d.getHours()).padStart(2, '0')
    const mins = String(d.getMinutes()).padStart(2, '0')
    if (isThisYear) {
      return `${month}-${day} ${hours}:${mins}`
    }
    return `${d.getFullYear()}-${month}-${day}`
  }

  const formatPermissions = (perms: string | undefined) => {
    if (!perms) return ''
    // Convert octal string like "755" to "rwxr-xr-x"
    const map: Record<string, string> = {
      '0': '---', '1': '--x', '2': '-w-', '3': '-wx',
      '4': 'r--', '5': 'r-x', '6': 'rw-', '7': 'rwx'
    }
    return perms.split('').map(c => map[c] || '---').join('')
  }

  const handleContextAction = (action: ContextMenuAction) => {
    const file = contextMenu.file
    setContextMenu(prev => ({ ...prev, visible: false }))

    switch (action) {
      case 'upload': return onUpload?.()
      case 'download': return onDownload?.()
      case 'delete': return onDelete?.()
      case 'rename': return startRename(file)
      case 'newFolder': return startCreateFolder()
      case 'refresh': return onNavigate(currentPath)
    }
  }

  const handleDragStart = (e: React.DragEvent, file: FileItem) => {
    const draggedFiles = selected.has(file.name)
      ? Array.from(selected)
      : [file.name]

    e.dataTransfer.setData(FILE_LIST_DRAG_TYPE, JSON.stringify({
      type,
      sessionId,
      fileNames: draggedFiles
    }))
    e.dataTransfer.effectAllowed = 'copyMove'
    folderDrop.startDrag(draggedFiles)
  }

  const handleDragOver = (e: React.DragEvent) => {
    // Inside the same list only folder rows accept a drop (they stop propagation before this),
    // and entries never cross into another session's panel (split panes show two at once)
    const isFileListDrag = e.dataTransfer.types.includes(FILE_LIST_DRAG_TYPE)
    if (isFileListDrag && (folderDrop.isDraggingWithinList() || !folderDrop.isDragFromThisSession())) {
      setIsDragOver(false)
      return
    }
    e.preventDefault()
    e.stopPropagation()
    e.dataTransfer.dropEffect = 'copy'
    setIsDragOver(true)
  }

  const handleDragLeave = (e: React.DragEvent) => {
    e.stopPropagation()
    if (e.currentTarget.contains(e.relatedTarget as Node)) return
    setIsDragOver(false)
  }

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    setIsDragOver(false)

    try {
      const data = JSON.parse(e.dataTransfer.getData(FILE_LIST_DRAG_TYPE))
      if (data.type !== type && data.sessionId === sessionId && data.fileNames?.length > 0 && onDrop) {
        onDrop(data.fileNames)
      }
    } catch {
      // Ignore invalid drag data
    }
  }

  return (
    <div
      ref={fileListRef}
      className={`file-list ${isDragOver ? 'drag-over' : ''}`}
      tabIndex={0}
      onKeyDown={handleListKeyDown}
      onBlur={handleBlur}
      onContextMenu={(e) => openContextMenu(e, null)}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      {isLoading && (
        <div className="file-list-loading">
          <div className="loading-spinner" />
          <span>로딩 중...</span>
        </div>
      )}
      <FileListHeader type={type} sort={sort} onSort={handleSort} />
      {/* Double-click like every other folder row; a single click only focuses the list */}
      <div
        className={`file-item parent-dir ${folderDrop.dropTargetKey === PARENT_ROW_KEY ? 'drop-target' : ''}`}
        onClick={focusList}
        onDoubleClick={goUp}
        title="상위 폴더 (더블클릭)"
        {...folderDrop.rowDropProps(PARENT_ROW_KEY, parentDir)}
      >
        <RiArrowUpSFill size={16} />
        <span>..</span>
      </div>
      {editing?.mode === 'create' && (
        <div className="file-item is-directory is-editing">
          <RiFolderFill size={16} className="folder-icon" />
          <InlineNameInput
            initialValue={editing.initialName}
            onCommit={commitCreateFolder}
            onCancel={finishEditing}
          />
        </div>
      )}
      {files.map((file, index) => {
        const isRenaming = editing?.mode === 'rename' && editing.name === file.name
        const mark = file.type === 'file' ? transferMarks.get(file.name) : undefined
        return (
          <div
            key={file.name}
            ref={(el) => { itemRefs.current[index] = el }}
            className={`file-item ${file.type === 'directory' ? 'is-directory' : 'is-file'} ${selected.has(file.name) ? 'selected' : ''} ${focusIndex === index ? 'focused' : ''} ${isRenaming ? 'is-editing' : ''} ${folderDrop.dropTargetKey === file.name ? 'drop-target' : ''} ${transferMarkClass(mark)}`}
            onClick={(e) => handleClick(e, file, index)}
            onDoubleClick={() => handleDoubleClick(file)}
            onContextMenu={(e) => openContextMenu(e, file)}
            draggable={!isRenaming}
            onDragStart={(e) => handleDragStart(e, file)}
            onDragEnd={folderDrop.endDrag}
            {...(file.type === 'directory' ? folderDrop.rowDropProps(file.name, childPath(file.name), file.name) : {})}
          >
            {file.type === 'directory' ? <RiFolderFill size={16} className="folder-icon" /> : getFileIcon(file.name)}
            {isRenaming ? (
              <InlineNameInput
                initialValue={file.name}
                selectBaseName={file.type === 'file'}
                onCommit={(value) => commitRename(file.name, value)}
                onCancel={finishEditing}
              />
            ) : (
              <span className="file-name">{file.name}</span>
            )}
            {mark && !isRenaming && <TransferMarkBadge mark={mark} />}
            {/* Always render the remote cells so rows stay aligned with the column headers */}
            {type === 'remote' && (
              <span className="file-owner" title={file.owner ? `소유자: ${file.owner}${file.group ? `  그룹: ${file.group}` : ''}` : undefined}>
                {file.owner ?? ''}
              </span>
            )}
            {type === 'remote' && (
              <span className="file-permissions" title={file.permissions ? `권한: ${file.permissions} (${formatPermissions(file.permissions)})` : undefined}>
                {formatPermissions(file.permissions)}
              </span>
            )}
            <span className="file-mtime">{formatDate(file.modifyTime)}</span>
            <span className="file-size">{file.type === 'file' ? formatSize(file.size) : ''}</span>
          </div>
        )
      })}

      {contextMenu.visible && (
        <FileListContextMenu
          ref={contextMenuRef}
          x={contextMenu.x}
          y={contextMenu.y}
          items={buildContextMenuItems({
            file: contextMenu.file,
            type,
            canRename: Boolean(onRename),
            canCreateFolder: Boolean(onCreateFolder),
            canDelete: Boolean(onDelete)
          })}
          onSelect={handleContextAction}
        />
      )}
    </div>
  )
}
