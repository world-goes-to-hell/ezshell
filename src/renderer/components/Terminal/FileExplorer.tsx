import { useState, useEffect, useCallback } from 'react'
import { RiArrowRightSLine, RiRefreshLine, RiHome4Fill, RiArrowUpLine, RiLinkUnlinkM, RiLinkM } from 'react-icons/ri'
import { motion, AnimatePresence } from 'framer-motion'
import { collapseVariants } from '../../lib/animation/variants'
import { useReducedMotion } from '../../hooks/useReducedMotion'
import { useTerminalStore } from '../../stores/terminalStore'
import { toFileNodes, type FileNode } from '../../lib/fileExplorerNodes'
import { FileExplorerIcon } from './FileExplorerIcon'

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
          className={`file-explorer-item ${node.isSymlink ? 'is-symlink' : ''} ${node.isBrokenLink ? 'is-broken-link' : ''}`}
          style={{ paddingLeft }}
          onClick={() => toggleNode(node, path)}
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
          <span className="file-explorer-name">
            {node.name}
            {node.isSymlink && node.linkTarget && (
              <span className="file-explorer-link-target"> → {node.linkTarget}</span>
            )}
          </span>
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
      <div className="file-explorer-content">
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
    </div>
  )
}
