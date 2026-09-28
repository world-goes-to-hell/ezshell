import { useState, useRef, useEffect } from 'react'
import { useSftpStore, FileItem } from '../../stores/sftpStore'
import {
  RiFolderFill, RiFileFill, RiArrowUpSFill, RiUploadFill, RiDownloadFill, RiDeleteBinFill,
  RiFileTextFill, RiFileCodeFill, RiImageFill, RiVideoFill, RiMusicFill,
  RiFilePdfFill, RiFileZipFill, RiDatabase2Fill, RiTerminalBoxFill,
  RiMarkdownFill, RiHtml5Fill, RiCss3Fill
} from 'react-icons/ri'

interface FileListProps {
  files: FileItem[]
  selected: Set<string>
  onNavigate: (path: string) => void
  currentPath: string
  type: 'local' | 'remote'
  sessionId: string
  onUpload?: () => void
  onDownload?: () => void
  onDrop?: (fileNames: string[]) => void
  isLoading?: boolean
}

interface ContextMenuState {
  visible: boolean
  x: number
  y: number
  file: FileItem | null
}

const isWindows = () => {
  return navigator.platform.toLowerCase().includes('win') ||
         navigator.userAgent.toLowerCase().includes('windows')
}

export function FileList({ files, selected, onNavigate, currentPath, type, sessionId, onUpload, onDownload, onDrop, isLoading }: FileListProps) {
  const store = useSftpStore()
  const [contextMenu, setContextMenu] = useState<ContextMenuState>({ visible: false, x: 0, y: 0, file: null })
  const contextMenuRef = useRef<HTMLDivElement>(null)
  const fileListRef = useRef<HTMLDivElement>(null)
  const itemRefs = useRef<(HTMLDivElement | null)[]>([])
  const [isDragOver, setIsDragOver] = useState(false)
  const [lastSelectedIndex, setLastSelectedIndex] = useState<number>(-1)
  const focusIndexRef = useRef<number>(-1)
  const [, forceUpdate] = useState(0)
  const focusIndex = focusIndexRef.current
  const setFocusIndex = (idx: number) => {
    focusIndexRef.current = idx
    forceUpdate(c => c + 1)
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
    setFocusIndex(-1)
  }, [files])

  // Ctrl+A handler on the file-list element itself
  const handleListKeyDown = (e: React.KeyboardEvent) => {
    if (isLoading) return
    if ((e.ctrlKey || e.metaKey) && e.key === 'a') {
      e.preventDefault()
      if (type === 'remote') {
        store.selectAllRemote(sessionId)
      } else {
        store.selectAllLocal(sessionId)
      }
      return
    }

    if (e.key === 'ArrowDown') {
      e.preventDefault()
      const startFrom = focusIndex >= 0 ? focusIndex : (lastSelectedIndex >= 0 ? lastSelectedIndex - 1 : -1)
      const nextIndex = Math.min(startFrom + 1, files.length - 1)
      setFocusIndex(nextIndex)
      if (e.shiftKey) {
        // Shift+ArrowDown: extend range selection
        const start = Math.min(lastSelectedIndex >= 0 ? lastSelectedIndex : nextIndex, nextIndex)
        const end = Math.max(lastSelectedIndex >= 0 ? lastSelectedIndex : nextIndex, nextIndex)
        const rangeNames = files.slice(start, end + 1).map(f => f.name)
        if (type === 'remote') {
          store.setRemoteMultiSelection(sessionId, rangeNames)
        } else {
          store.setLocalMultiSelection(sessionId, rangeNames)
        }
      } else {
        // Normal ArrowDown: single select
        if (type === 'remote') {
          store.setRemoteSelection(sessionId, files[nextIndex].name)
        } else {
          store.setLocalSelection(sessionId, files[nextIndex].name)
        }
        setLastSelectedIndex(nextIndex)
      }
      // Scroll focused item into view
      itemRefs.current[nextIndex]?.scrollIntoView({ block: 'nearest' })
    }

    if (e.key === 'ArrowUp') {
      e.preventDefault()
      const startFrom = focusIndex >= 0 ? focusIndex : (lastSelectedIndex >= 0 ? lastSelectedIndex + 1 : files.length)
      const prevIndex = Math.max(startFrom - 1, 0)
      setFocusIndex(prevIndex)
      if (e.shiftKey) {
        const start = Math.min(lastSelectedIndex >= 0 ? lastSelectedIndex : prevIndex, prevIndex)
        const end = Math.max(lastSelectedIndex >= 0 ? lastSelectedIndex : prevIndex, prevIndex)
        const rangeNames = files.slice(start, end + 1).map(f => f.name)
        if (type === 'remote') {
          store.setRemoteMultiSelection(sessionId, rangeNames)
        } else {
          store.setLocalMultiSelection(sessionId, rangeNames)
        }
      } else {
        if (type === 'remote') {
          store.setRemoteSelection(sessionId, files[prevIndex].name)
        } else {
          store.setLocalSelection(sessionId, files[prevIndex].name)
        }
        setLastSelectedIndex(prevIndex)
      }
      itemRefs.current[prevIndex]?.scrollIntoView({ block: 'nearest' })
    }

    if (e.key === 'ArrowRight') {
      if (focusIndex >= 0 && focusIndex < files.length) {
        const file = files[focusIndex]
        if (file.type === 'directory') {
          e.preventDefault()
          const separator = type === 'local' && isWindows() ? '\\' : '/'
          const newPath = currentPath === '/' || currentPath === 'C:\\'
            ? (type === 'local' && isWindows() ? `${currentPath}${file.name}` : `/${file.name}`)
            : `${currentPath}${separator}${file.name}`
          onNavigate(newPath)
          setFocusIndex(-1)
        }
      }
    }

    if (e.key === 'ArrowLeft') {
      e.preventDefault()
      goUp()
      setFocusIndex(-1)
    }

    if (e.key === 'Enter') {
      e.preventDefault()
      if (focusIndex >= 0 && focusIndex < files.length) {
        const file = files[focusIndex]
        if (file.type === 'directory') {
          const separator = type === 'local' && isWindows() ? '\\' : '/'
          const newPath = currentPath === '/' || currentPath === 'C:\\'
            ? (type === 'local' && isWindows() ? `${currentPath}${file.name}` : `/${file.name}`)
            : `${currentPath}${separator}${file.name}`
          onNavigate(newPath)
          setFocusIndex(-1)
        }
      }
    }

    if (e.key === 'Backspace') {
      e.preventDefault()
      goUp()
      setFocusIndex(-1)
    }
  }

  const handleBlur = (e: React.FocusEvent) => {
    if (e.currentTarget.contains(e.relatedTarget as Node)) return
    if (type === 'remote') {
      store.clearRemoteSelection(sessionId)
    } else {
      store.clearLocalSelection(sessionId)
    }
    setFocusIndex(-1)
  }

  const handleClick = (e: React.MouseEvent, file: FileItem, index: number) => {
    // Focus the file list so Ctrl+A works
    fileListRef.current?.focus()
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
      const rangeNames = files.slice(start, end + 1).map(f => f.name)
      if (type === 'remote') {
        store.setRemoteMultiSelection(sessionId, rangeNames)
      } else {
        store.setLocalMultiSelection(sessionId, rangeNames)
      }
    } else {
      // Normal click: single select
      if (type === 'remote') {
        store.setRemoteSelection(sessionId, file.name)
      } else {
        store.setLocalSelection(sessionId, file.name)
      }
      setLastSelectedIndex(index)
    }
  }

  const handleContextMenu = (e: React.MouseEvent, file: FileItem) => {
    e.preventDefault()

    // Select the file if not already selected
    if (!selected.has(file.name)) {
      if (type === 'remote') {
        store.setRemoteSelection(sessionId, file.name)
      } else {
        store.setLocalSelection(sessionId, file.name)
      }
    }

    // Calculate position with boundary checking
    const menuWidth = 150
    const menuHeight = 120
    let x = e.clientX
    let y = e.clientY

    // Adjust if menu would go off right edge
    if (x + menuWidth > window.innerWidth) {
      x = window.innerWidth - menuWidth - 10
    }

    // Adjust if menu would go off bottom edge
    if (y + menuHeight > window.innerHeight) {
      y = window.innerHeight - menuHeight - 10
    }

    setContextMenu({
      visible: true,
      x,
      y,
      file
    })
  }

  const handleDoubleClick = (file: FileItem) => {
    if (file.type === 'directory') {
      const separator = type === 'local' && isWindows() ? '\\' : '/'
      const newPath = currentPath === '/' || currentPath === 'C:\\'
        ? (type === 'local' && isWindows() ? `${currentPath}${file.name}` : `/${file.name}`)
        : `${currentPath}${separator}${file.name}`
      onNavigate(newPath)
    }
  }

  const goUp = () => {
    const isWin = isWindows()
    if (type === 'local' && isWin) {
      const parts = currentPath.split('\\').filter(Boolean)
      if (parts.length > 1) {
        parts.pop()
        onNavigate(parts.join('\\') + '\\')
      } else {
        onNavigate('C:\\')
      }
    } else {
      const parts = currentPath.split('/').filter(Boolean)
      if (parts.length > 0) {
        parts.pop()
        onNavigate(parts.length === 0 ? '/' : `/${parts.join('/')}`)
      }
    }
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

  const handleContextAction = (action: 'upload' | 'download' | 'delete') => {
    setContextMenu(prev => ({ ...prev, visible: false }))

    if (action === 'upload' && onUpload) {
      onUpload()
    } else if (action === 'download' && onDownload) {
      onDownload()
    }
    // Delete can be implemented later
  }

  const getFileIcon = (fileName: string) => {
    const ext = fileName.split('.').pop()?.toLowerCase() || ''
    const iconSize = 14

    // Images
    if (['png', 'jpg', 'jpeg', 'gif', 'svg', 'bmp', 'webp', 'ico'].includes(ext))
      return <RiImageFill size={iconSize} className="file-icon icon-image" />
    // Videos
    if (['mp4', 'avi', 'mkv', 'mov', 'wmv', 'flv', 'webm'].includes(ext))
      return <RiVideoFill size={iconSize} className="file-icon icon-video" />
    // Audio
    if (['mp3', 'wav', 'ogg', 'flac', 'aac', 'wma', 'm4a'].includes(ext))
      return <RiMusicFill size={iconSize} className="file-icon icon-audio" />
    // Archives
    if (['zip', 'tar', 'gz', 'rar', '7z', 'bz2', 'xz', 'tgz'].includes(ext))
      return <RiFileZipFill size={iconSize} className="file-icon icon-archive" />
    // PDF
    if (ext === 'pdf')
      return <RiFilePdfFill size={iconSize} className="file-icon icon-pdf" />
    // Markdown
    if (['md', 'mdx'].includes(ext))
      return <RiMarkdownFill size={iconSize} className="file-icon icon-markdown" />
    // HTML
    if (['html', 'htm', 'xhtml'].includes(ext))
      return <RiHtml5Fill size={iconSize} className="file-icon icon-html" />
    // CSS
    if (['css', 'scss', 'sass', 'less'].includes(ext))
      return <RiCss3Fill size={iconSize} className="file-icon icon-css" />
    // Code files
    if (['js', 'jsx', 'ts', 'tsx', 'py', 'java', 'c', 'cpp', 'h', 'go', 'rs', 'rb', 'php', 'swift', 'kt', 'vue', 'svelte'].includes(ext))
      return <RiFileCodeFill size={iconSize} className="file-icon icon-code" />
    // Config/data
    if (['json', 'yaml', 'yml', 'toml', 'xml', 'ini', 'env', 'conf', 'cfg'].includes(ext))
      return <RiDatabase2Fill size={iconSize} className="file-icon icon-config" />
    // Shell/scripts
    if (['sh', 'bash', 'zsh', 'fish', 'bat', 'cmd', 'ps1'].includes(ext))
      return <RiTerminalBoxFill size={iconSize} className="file-icon icon-shell" />
    // Text files
    if (['txt', 'log', 'csv', 'tsv', 'rtf'].includes(ext))
      return <RiFileTextFill size={iconSize} className="file-icon icon-text" />
    // Default
    return <RiFileFill size={iconSize} className="file-icon" />
  }

  const handleDragStart = (e: React.DragEvent, file: FileItem) => {
    const draggedFiles = selected.has(file.name)
      ? Array.from(selected)
      : [file.name]

    e.dataTransfer.setData('application/json', JSON.stringify({
      type,
      fileNames: draggedFiles
    }))
    e.dataTransfer.effectAllowed = 'copy'
  }

  const handleDragOver = (e: React.DragEvent) => {
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
      const data = JSON.parse(e.dataTransfer.getData('application/json'))
      if (data.type !== type && data.fileNames?.length > 0 && onDrop) {
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
      <div className="file-item parent-dir" onClick={goUp}>
        <RiArrowUpSFill size={14} />
        <span>..</span>
      </div>
      {files.map((file, index) => (
        <div
          key={file.name}
          ref={(el) => { itemRefs.current[index] = el }}
          className={`file-item ${file.type === 'directory' ? 'is-directory' : 'is-file'} ${selected.has(file.name) ? 'selected' : ''} ${focusIndex === index ? 'focused' : ''}`}
          onClick={(e) => handleClick(e, file, index)}
          onDoubleClick={() => handleDoubleClick(file)}
          onContextMenu={(e) => handleContextMenu(e, file)}
          draggable
          onDragStart={(e) => handleDragStart(e, file)}
        >
          {file.type === 'directory' ? <RiFolderFill size={14} className="folder-icon" /> : getFileIcon(file.name)}
          <span className="file-name">{file.name}</span>
          {type === 'remote' && file.permissions && (
            <span className="file-permissions" title={`권한: ${file.permissions} (${formatPermissions(file.permissions)})`}>
              {formatPermissions(file.permissions)}
            </span>
          )}
          <span className="file-mtime">{formatDate(file.modifyTime)}</span>
          <span className="file-size">{file.type === 'file' ? formatSize(file.size) : ''}</span>
        </div>
      ))}

      {/* Context Menu */}
      {contextMenu.visible && (
        <div
          ref={contextMenuRef}
          className="context-menu"
          style={{ top: contextMenu.y, left: contextMenu.x }}
        >
          {type === 'local' && (
            <div className="context-menu-item" onClick={() => handleContextAction('upload')}>
              <RiUploadFill size={14} />
              <span>업로드</span>
            </div>
          )}
          {type === 'remote' && (
            <div className="context-menu-item" onClick={() => handleContextAction('download')}>
              <RiDownloadFill size={14} />
              <span>다운로드</span>
            </div>
          )}
          <div className="context-menu-divider" />
          <div className="context-menu-item danger" onClick={() => handleContextAction('delete')}>
            <RiDeleteBinFill size={14} />
            <span>삭제</span>
          </div>
        </div>
      )}
    </div>
  )
}
