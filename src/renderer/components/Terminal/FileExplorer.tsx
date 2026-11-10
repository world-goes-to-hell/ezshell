import { useState, useEffect, useCallback, useRef } from 'react'
import { RiArrowRightSLine, RiRefreshLine, RiHome4Fill, RiArrowUpLine, RiLinkUnlinkM, RiLinkM, RiFolderAddFill } from 'react-icons/ri'
import { motion, AnimatePresence } from 'framer-motion'
import { collapseVariants } from '../../lib/animation/variants'
import { useReducedMotion } from '../../hooks/useReducedMotion'
import { useTerminalStore } from '../../stores/terminalStore'
import { toast } from '../../stores/toastStore'
import { toFileNodes, type FileNode } from '../../lib/fileExplorerNodes'
import { mergeRoot, parentOf, replaceChildren, toFileItem } from '../../lib/fileExplorerTree'
import { openRemoteFileWindow } from '../../lib/remoteFileOpen'
import { renameEntry, createFolder } from '../../lib/sftpFileOps'
import { deleteRemoteSelection } from '../../lib/sftpRemoteDelete'
import { FileListContextMenu, buildContextMenuItems, type ContextMenuAction } from '../Sftp/FileListContextMenu'
import { FileExplorerIcon } from './FileExplorerIcon'
import '../Sftp/FileList.css'

function nodeTooltip(node: FileNode): string {
  if (!node.isSymlink) return node.path
  const target = node.linkTarget ?? '(대상을 읽을 수 없음)'
  return `${node.path} → ${target}${node.isBrokenLink ? ' (깨진 링크)' : ''}`
}

interface FileExplorerProps {
  sessionId: string
  onFileSelect?: (path: string) => void
}

export function FileExplorer({ sessionId, onFileSelect }: FileExplorerProps) {
  const [rootNodes, setRootNodes] = useState<FileNode[]>([])
  const [loading, setLoading] = useState(true)
  const [displayPath, setDisplayPath] = useState('/')
  const [error, setError] = useState<string | null>(null)
  const [initialized, setInitialized] = useState(false)
  const [isEditingPath, setIsEditingPath] = useState(false)
  const [editingPathValue, setEditingPathValue] = useState('')
  const [autoSyncEnabled, setAutoSyncEnabled] = useState(true)
  const reducedMotion = useReducedMotion()

  // Get current path from terminal store
  const terminal = useTerminalStore(state => state.terminals.get(sessionId))
  const currentPath = terminal?.currentPath || '/'

  const loadDirectory = useCallback(async (path: string): Promise<FileNode[]> => {
    try {
      const rawFiles = await window.electronAPI.sftpList(sessionId, path)
      return toFileNodes(rawFiles || [], path)
    } catch (error) {
      console.error('Failed to load directory:', error)
      return []
    }
  }, [sessionId])

  const loadPath = useCallback(async (path: string) => {
    setLoading(true)
    setError(null)
    try {
      const nodes = await loadDirectory(path)
      setRootNodes(nodes)
      setDisplayPath(path)
    } catch (err) {
      console.error('Failed to load path:', err)
      setError('디렉토리 로드 실패')
    } finally {
      setLoading(false)
    }
  }, [loadDirectory])

  const loadRoot = useCallback(async () => {
    await loadPath('/')
  }, [loadPath])

  const goToParent = useCallback(async () => {
    if (displayPath === '/') return
    const parentPath = displayPath.split('/').slice(0, -1).join('/') || '/'
    await loadPath(parentPath)
  }, [displayPath, loadPath])


  useEffect(() => {
    // Try to open SFTP first, then load
    const init = async () => {
      setLoading(true)
      setError(null)
      try {
        await window.electronAPI.sftpOpen(sessionId)
        // Start with root or home directory
        const initialPath = currentPath && currentPath !== '~' ? currentPath : '/'
        const nodes = await loadDirectory(initialPath)
        setRootNodes(nodes)
        setDisplayPath(initialPath)
        setInitialized(true)
      } catch (err: any) {
        console.error('Failed to initialize file explorer:', err)
        setError(err?.message || 'SFTP 연결 실패')
      } finally {
        setLoading(false)
      }
    }
    init()
  }, [sessionId, loadDirectory])

  // Reload when current path changes (from terminal cd commands) - only if auto-sync is enabled
  useEffect(() => {
    if (autoSyncEnabled && initialized && currentPath && currentPath !== displayPath) {
      // Handle ~ as home directory - convert to / for SFTP
      const targetPath = currentPath === '~' ? '/' : currentPath
      if (targetPath !== displayPath) {
        loadPath(targetPath)
      }
    }
  }, [autoSyncEnabled, initialized, currentPath, displayPath, loadPath])

  // ---- Context menu: the same items and actions as the SFTP panel's remote list ----
  const [menu, setMenu] = useState<{ x: number; y: number; node: FileNode | null } | null>(null)
  const [selectedPath, setSelectedPath] = useState<string | null>(null)
  const [renaming, setRenaming] = useState<string | null>(null)
  const [creatingIn, setCreatingIn] = useState<string | null>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const sessionName = terminal?.title || (terminal ? `${terminal.username}@${terminal.host}` : '')

  useEffect(() => {
    if (!menu) return
    const close = (event: Event) => {
      if (event instanceof KeyboardEvent && event.key !== 'Escape') return
      if (event.type === 'mousedown' && menuRef.current?.contains(event.target as Node)) return
      setMenu(null)
    }
    document.addEventListener('mousedown', close)
    document.addEventListener('keydown', close)
    window.addEventListener('blur', close)
    return () => {
      document.removeEventListener('mousedown', close)
      document.removeEventListener('keydown', close)
      window.removeEventListener('blur', close)
    }
  }, [menu])

  const openMenu = (event: React.MouseEvent, node: FileNode | null) => {
    event.preventDefault()
    event.stopPropagation()
    if (node) setSelectedPath(node.path)
    setMenu({ x: event.clientX, y: event.clientY, node })
  }

  /** Reads one folder again; the rest of the tree keeps its open folders */
  const reloadDir = async (dirPath: string) => {
    const children = await loadDirectory(dirPath)
    setRootNodes(prev => (dirPath === displayPath ? mergeRoot(prev, children) : replaceChildren(prev, dirPath, children)))
  }

  const download = async (node: FileNode) => {
    if (node.type === 'directory') {
      toast.info('폴더는 다운로드할 수 없습니다', '파일을 선택해 주세요. 폴더 다운로드는 아직 지원하지 않습니다')
      return
    }
    const target = await window.electronAPI.selectDownloadPath(node.name)
    if (!target?.success || !target.path) return
    toast.info('다운로드 중', node.name)
    try {
      await window.electronAPI.sftpDownload(sessionId, node.path, target.path)
      toast.success('다운로드 완료', target.path)
    } catch (err) {
      toast.error('다운로드 실패', err instanceof Error ? err.message : String(err))
    }
  }

  const runMenuAction = async (action: ContextMenuAction) => {
    const node = menu?.node ?? null
    setMenu(null)
    if (action === 'refresh' || action === 'newFolder') {
      const folder = !node ? displayPath : node.type === 'directory' ? node.path : parentOf(node.path)
      if (action === 'refresh') await reloadDir(folder)
      else setCreatingIn(folder)
      return
    }
    if (!node) return
    if (action === 'preview' || action === 'tail' || action === 'edit') {
      await openRemoteFileWindow(sessionId, sessionName, parentOf(node.path), node.name, action)
    } else if (action === 'download') {
      await download(node)
    } else if (action === 'rename') {
      setRenaming(node.path)
    } else if (action === 'delete') {
      const folder = parentOf(node.path)
      if (await deleteRemoteSelection(sessionId, folder, new Set([node.name]), [toFileItem(node)])) {
        setSelectedPath(null)
        await reloadDir(folder)
      }
    }
  }

  // Enter removes the input, which then also blurs: the second call must do nothing
  const isFinishing = useRef(false)

  const finishRename = async (node: FileNode, newName: string) => {
    if (isFinishing.current) return
    isFinishing.current = true
    setRenaming(null)
    setTimeout(() => { isFinishing.current = false }, 0)
    const name = newName.trim()
    if (!name || name === node.name || name.includes('/')) return
    const folder = parentOf(node.path)
    if (await renameEntry({ side: 'remote', sessionId, dirPath: folder, oldName: node.name, newName: name })) await reloadDir(folder)
  }

  const finishCreate = async (folder: string, name: string) => {
    if (isFinishing.current) return
    isFinishing.current = true
    setCreatingIn(null)
    setTimeout(() => { isFinishing.current = false }, 0)
    const clean = name.trim()
    if (!clean || clean.includes('/')) return
    if (await createFolder({ side: 'remote', sessionId, dirPath: folder, name: clean })) await reloadDir(folder)
  }

  // No F2 / Delete keys in the explorer, so the menu shows no shortcuts
  const menuItems = menu
    ? buildContextMenuItems({
      file: menu.node ? toFileItem(menu.node) : null,
      type: 'remote',
      canRename: true,
      canCreateFolder: true,
      canDelete: true,
      canOpenFile: true
    }).map(({ shortcut: _shortcut, ...item }) => item)
    : []

  const toggleNode = async (node: FileNode, path: number[]) => {
    if (node.type !== 'directory') {
      onFileSelect?.(node.path)
      return
    }

    const updateNodes = (nodes: FileNode[], pathIndex: number): FileNode[] => {
      return nodes.map((n, i) => {
        if (i === path[pathIndex]) {
          if (pathIndex === path.length - 1) {
            // This is the target node
            const newNode = { ...n, isExpanded: !n.isExpanded }
            if (!n.isLoaded && !n.isExpanded) {
              // Load children
              loadDirectory(n.path).then(children => {
                setRootNodes(prev => {
                  const update = (nodes: FileNode[], idx: number): FileNode[] => {
                    return nodes.map((node, j) => {
                      if (j === path[idx]) {
                        if (idx === path.length - 1) {
                          return { ...node, children, isLoaded: true }
                        }
                        return { ...node, children: update(node.children || [], idx + 1) }
                      }
                      return node
                    })
                  }
                  return update(prev, 0)
                })
              })
            }
            return newNode
          }
          return { ...n, children: updateNodes(n.children || [], pathIndex + 1) }
        }
        return n
      })
    }

    setRootNodes(prev => updateNodes(prev, 0))
  }

  const renderNode = (node: FileNode, path: number[], depth: number = 0) => {
    const isDir = node.type === 'directory'
    const paddingLeft = depth * 16 + 8


    return (
      <div key={node.path}>
        <motion.div
          className={`file-explorer-item ${node.isSymlink ? 'is-symlink' : ''} ${node.isBrokenLink ? 'is-broken-link' : ''} ${selectedPath === node.path ? 'is-selected' : ''}`}
          style={{ paddingLeft }}
          onClick={() => {
            setSelectedPath(node.path)
            if (renaming !== node.path) void toggleNode(node, path)
          }}
          onContextMenu={(e) => openMenu(e, node)}
          title={nodeTooltip(node)}
          whileHover={reducedMotion ? undefined : { backgroundColor: 'var(--bg-hover)' }}
          transition={{ duration: 0.15 }}
        >
          {isDir ? (
            <motion.span
              className="expand-icon"
              animate={{ rotate: node.isExpanded ? 90 : 0 }}
              transition={reducedMotion ? { duration: 0 } : { duration: 0.15 }}
            >
              <RiArrowRightSLine size={16} />
            </motion.span>
          ) : (
            <span className="expand-icon" style={{ visibility: 'hidden' }}>
              <RiArrowRightSLine size={16} />
            </span>
          )}
          <FileExplorerIcon node={node} />
          {renaming === node.path ? (
            <input
              className="file-explorer-inline-input"
              defaultValue={node.name}
              autoFocus
              aria-label="새 이름"
              onClick={(e) => e.stopPropagation()}
              onFocus={(e) => {
                // Select the name without its extension, like the SFTP list
                const dot = node.type === 'file' ? node.name.lastIndexOf('.') : -1
                e.target.setSelectionRange(0, dot > 0 ? dot : node.name.length)
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void finishRename(node, e.currentTarget.value)
                if (e.key === 'Escape') setRenaming(null)
              }}
              onBlur={(e) => void finishRename(node, e.target.value)}
            />
          ) : (
            <span className="file-explorer-name">
              {node.name}
              {node.isSymlink && node.linkTarget && (
                <span className="file-explorer-link-target"> → {node.linkTarget}</span>
              )}
            </span>
          )}
        </motion.div>
        <AnimatePresence initial={false}>
          {isDir && node.isExpanded && node.children && (
            <motion.div
              className="file-explorer-children"
              variants={reducedMotion ? undefined : collapseVariants}
              initial="hidden"
              animate="visible"
              exit="hidden"
            >
              {node.children.map((child, i) => renderNode(child, [...path, i], depth + 1))}
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    )
  }

  return (
    <div className="file-explorer">
      <div className="file-explorer-header">
        <span className="file-explorer-title" title={displayPath}>
          {displayPath === '/' ? '/' : displayPath.split('/').pop() || displayPath}
        </span>
        <div className="file-explorer-actions">
          <button
            className="file-explorer-btn"
            onClick={goToParent}
            title="상위 디렉토리"
            disabled={displayPath === '/'}
          >
            <RiArrowUpLine size={16} />
          </button>
          <button className="file-explorer-btn" onClick={loadRoot} title="루트(/)로 이동">
            <RiHome4Fill size={16} />
          </button>
          <button className="file-explorer-btn" onClick={() => loadPath(displayPath)} title="새로고침">
            <RiRefreshLine size={16} />
          </button>
          <button
            className={`file-explorer-btn ${autoSyncEnabled ? 'active' : ''}`}
            onClick={() => setAutoSyncEnabled(!autoSyncEnabled)}
            title={autoSyncEnabled ? '터미널 경로 자동 동기화 켜짐 (클릭하여 끄기)' : '터미널 경로 자동 동기화 꺼짐 (클릭하여 켜기)'}
          >
            {autoSyncEnabled ? <RiLinkM size={16} /> : <RiLinkUnlinkM size={16} />}
          </button>
        </div>
      </div>
      {isEditingPath ? (
        <input
          className="file-explorer-path-input"
          type="text"
          value={editingPathValue}
          onChange={(e) => setEditingPathValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              const newPath = editingPathValue.trim() || '/'
              setIsEditingPath(false)
              loadPath(newPath)
            } else if (e.key === 'Escape') {
              setIsEditingPath(false)
            }
          }}
          onBlur={() => setIsEditingPath(false)}
          autoFocus
          placeholder="경로 입력 (예: /home/user)"
        />
      ) : (
        <div
          className="file-explorer-path"
          title={`${displayPath} (클릭하여 경로 직접 입력)`}
          onClick={() => {
            setEditingPathValue(displayPath)
            setIsEditingPath(true)
          }}
        >
          {displayPath}
        </div>
      )}
      <div className="file-explorer-content" onContextMenu={(e) => { if (!loading && !error) openMenu(e, null) }}>
        {creatingIn && (
          <div className="file-explorer-item file-explorer-create" title={`${creatingIn} 안에 새 폴더`}>
            <RiFolderAddFill size={16} className="file-explorer-create-icon" aria-hidden="true" />
            <input
              className="file-explorer-inline-input"
              autoFocus
              placeholder={`새 폴더 이름 (${creatingIn})`}
              aria-label="새 폴더 이름"
              onKeyDown={(e) => {
                if (e.key === 'Enter') void finishCreate(creatingIn, e.currentTarget.value)
                if (e.key === 'Escape') setCreatingIn(null)
              }}
              onBlur={(e) => void finishCreate(creatingIn, e.target.value)}
            />
          </div>
        )}
        {loading ? (
          <div className="file-explorer-loading">연결 중...</div>
        ) : error ? (
          <div className="file-explorer-error">
            <span>{error}</span>
            <button
              className="file-explorer-retry-btn"
              onClick={() => {
                setError(null)
                setInitialized(false)
                window.electronAPI.sftpOpen(sessionId).then(() => {
                  loadPath('/')
                  setInitialized(true)
                }).catch((err: any) => {
                  setError(err?.message || 'SFTP 연결 실패')
                })
              }}
            >
              재시도
            </button>
          </div>
        ) : rootNodes.length === 0 ? (
          <div className="file-explorer-empty">파일 없음</div>
        ) : (
          rootNodes.map((node, i) => renderNode(node, [i], 0))
        )}
      </div>
      {menu && (
        <FileListContextMenu ref={menuRef} x={menu.x} y={menu.y} items={menuItems} onSelect={(action) => void runMenuAction(action)} />
      )}
    </div>
  )
}
