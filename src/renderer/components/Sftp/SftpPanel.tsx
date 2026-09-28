import { useEffect, useState, useRef, useCallback } from 'react'
import { useSftpStore, FileItem } from '../../stores/sftpStore'
import { FileList, keepSelectionProps } from './FileList'
import { TransferQueue } from './TransferQueue'
import { PathBar } from './PathBar'
import { OverwriteModal, OverwriteAction } from './OverwriteModal'
import { toast } from '../../stores/toastStore'
import { RiCloseFill, RiUploadFill, RiDownloadFill, RiRefreshFill, RiExternalLinkFill, RiLinkM, RiLinkUnlinkM, RiArrowUpDownLine } from 'react-icons/ri'
import { RxDragHandleDots2 } from 'react-icons/rx'
import { deleteRemoteSelection } from '../../lib/sftpRemoteDelete'
import { useTransferQueue } from '../../hooks/useTransferQueue'

interface PendingTransfer {
  type: 'upload' | 'download'
  fileName: string
  localPath: string
  remotePath: string
}

interface SftpPanelProps {
  sessionId: string
}

export function SftpPanel({ sessionId }: SftpPanelProps) {
  const store = useSftpStore()
  const transferQueue = useTransferQueue(sessionId)
  const getStoreState = () => useSftpStore.getState()

  // Get session-specific state
  const isOpen = store.isOpen(sessionId)
  const remotePath = store.remotePath(sessionId)
  const remoteFiles = store.remoteFiles(sessionId)
  const localPath = store.localPath(sessionId)
  const localFiles = store.localFiles(sessionId)
  const selectedRemote = store.selectedRemote(sessionId)
  const selectedLocal = store.selectedLocal(sessionId)
  const panelHeight = store.panelHeight(sessionId)

  const [isResizing, setIsResizing] = useState(false)
  const panelRef = useRef<HTMLDivElement>(null)

  // Overwrite modal state
  const [overwriteModalOpen, setOverwriteModalOpen] = useState(false)
  const [conflictFileName, setConflictFileName] = useState('')
  const [pendingTransfers, setPendingTransfers] = useState<PendingTransfer[]>([])
  const [currentTransferIndex, setCurrentTransferIndex] = useState(0)
  const [globalOverwriteAction, setGlobalOverwriteAction] = useState<OverwriteAction | null>(null)

  // Transfer queue resize state
  const [transferHeight, setTransferHeight] = useState(120)
  const [isTransferResizing, setIsTransferResizing] = useState(false)

  // Directory sync state
  const [isSyncMode, setIsSyncMode] = useState(false)
  const syncTriggeredRef = useRef(false)
  const [isLocalLoading, setIsLocalLoading] = useState(false)
  const [isRemoteLoading, setIsRemoteLoading] = useState(false)

  // Resize handlers
  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault()
    setIsResizing(true)
  }, [])

  useEffect(() => {
    const handleMouseMove = (e: MouseEvent) => {
      if (!isResizing) return

      const windowHeight = window.innerHeight
      const newHeight = windowHeight - e.clientY
      // Clamp height between 150 and 80% of window height
      const clampedHeight = Math.max(150, Math.min(newHeight, windowHeight * 0.8))
      store.setPanelHeight(sessionId, clampedHeight)
    }

    const handleMouseUp = () => {
      setIsResizing(false)
    }

    if (isResizing) {
      document.addEventListener('mousemove', handleMouseMove)
      document.addEventListener('mouseup', handleMouseUp)
    }

    return () => {
      document.removeEventListener('mousemove', handleMouseMove)
      document.removeEventListener('mouseup', handleMouseUp)
    }
  }, [isResizing, sessionId, store])

  // Transfer queue resize handlers
  useEffect(() => {
    const handleTransferMouseMove = (e: MouseEvent) => {
      if (!isTransferResizing || !panelRef.current) return
      const panelRect = panelRef.current.getBoundingClientRect()
      const newHeight = panelRect.bottom - e.clientY
      const maxHeight = panelRect.height * 0.5
      const clampedHeight = Math.max(60, Math.min(newHeight, maxHeight))
      setTransferHeight(clampedHeight)
    }

    const handleTransferMouseUp = () => {
      setIsTransferResizing(false)
    }

    if (isTransferResizing) {
      document.addEventListener('mousemove', handleTransferMouseMove)
      document.addEventListener('mouseup', handleTransferMouseUp)
    }

    return () => {
      document.removeEventListener('mousemove', handleTransferMouseMove)
      document.removeEventListener('mouseup', handleTransferMouseUp)
    }
  }, [isTransferResizing])

  const handlePopOut = async () => {
    // Open SFTP in a new window
    if (window.electronAPI.openSftpWindow) {
      await window.electronAPI.openSftpWindow(sessionId, localPath, remotePath)
    }
  }

  useEffect(() => {
    const initSftp = async () => {
      if (isOpen && sessionId) {
        try {
          await window.electronAPI.sftpOpen(sessionId)
          toast.info('SFTP session opened')
          await Promise.all([
            loadRemoteFiles(remotePath || '/'),
            loadLocalFiles(localPath || getDefaultLocalPath())
          ])
        } catch (error) {
          console.error('Failed to initialize SFTP:', error)
          toast.error('SFTP initialization failed', error instanceof Error ? error.message : 'Unknown error')
        }
      }
    }
    initSftp()
  }, [isOpen, sessionId])

  const getDefaultLocalPath = () => {
    // Check if Windows by looking at navigator.platform or userAgent
    const isWindows = navigator.platform.toLowerCase().includes('win') ||
                      navigator.userAgent.toLowerCase().includes('windows')
    return isWindows ? 'C:\\' : '/'
  }

  const loadRemoteFiles = async (path: string, fromSync = false) => {
    if (!fromSync && (isRemoteLoading || isLocalLoading)) return
    setIsRemoteLoading(true)
    const prevRemotePath = remotePath
    store.setRemotePath(sessionId, path)
    try {
      const rawFiles = await window.electronAPI.sftpList(sessionId, path)
      const files = (rawFiles || []).map((f: any) => ({
        name: f.name,
        type: f.isDirectory ? 'directory' : 'file',
        size: f.size,
        modifyTime: f.mtime,
        permissions: f.permissions,
        owner: f.owner,
        group: f.group
      }))
      store.setRemoteFiles(sessionId, files)

      // Directory sync: when remote navigates, sync local
      if (isSyncMode && !syncTriggeredRef.current && prevRemotePath !== path) {
        syncTriggeredRef.current = true
        try {
          const isGoingUp = path.split('/').filter(Boolean).length < prevRemotePath.split('/').filter(Boolean).length
          if (isGoingUp) {
            const depthDiff = prevRemotePath.split('/').filter(Boolean).length - path.split('/').filter(Boolean).length
            const currentLocalPath = getStoreState().localPath(sessionId)
            const isWin = isWindowsPath(currentLocalPath)
            if (isWin) {
              const parts = currentLocalPath.split('\\').filter(Boolean)
              const removeLevels = Math.min(depthDiff, parts.length - 1)
              if (removeLevels > 0) {
                const newParts = parts.slice(0, parts.length - removeLevels)
                await loadLocalFiles(newParts.join('\\') + '\\', true)
              }
            } else {
              const parts = currentLocalPath.split('/').filter(Boolean)
              const removeLevels = Math.min(depthDiff, parts.length)
              const newParts = parts.slice(0, parts.length - removeLevels)
              await loadLocalFiles(newParts.length === 0 ? '/' : `/${newParts.join('/')}`, true)
            }
          } else {
            // Going deeper: extract entered directory name
            const enteredDir = path.split('/').filter(Boolean).pop()
            if (enteredDir) {
              const currentLocalPath = getStoreState().localPath(sessionId)
              const currentLocalFiles = getStoreState().localFiles(sessionId)
              const localHasDir = currentLocalFiles.some(f => f.name === enteredDir && f.type === 'directory')
              if (localHasDir) {
                await loadLocalFiles(joinPath(currentLocalPath, enteredDir, isWindowsPath(currentLocalPath)), true)
              } else {
                // Target directory doesn't exist on local side
                setIsSyncMode(false)
                toast.info('동기화 해제', `'${enteredDir}' 디렉토리가 로컬에 없어 동기화가 해제되었습니다.`)
              }
            }
          }
        } finally {
          syncTriggeredRef.current = false
        }
      }
    } catch (error) {
      console.error('Failed to load remote files:', error)
      toast.error('Failed to load remote files', error instanceof Error ? error.message : 'Unknown error')
      store.setRemotePath(sessionId, prevRemotePath)
    } finally {
      setIsRemoteLoading(false)
    }
  }

  const loadLocalFiles = async (path: string, fromSync = false) => {
    if (!fromSync && (isLocalLoading || isRemoteLoading)) return
    setIsLocalLoading(true)
    const prevLocalPath = localPath
    store.setLocalPath(sessionId, path)
    try {
      const result = await window.electronAPI.localList(path)
      if (result.success) {
        const files = (result.files || []).map((f: any) => ({
          name: f.name,
          type: f.isDirectory ? 'directory' : 'file',
          size: f.size,
          modifyTime: f.mtime
        }))
        store.setLocalFiles(sessionId, files)

        // Directory sync: when local navigates, sync remote
        if (isSyncMode && !syncTriggeredRef.current && prevLocalPath !== path) {
          syncTriggeredRef.current = true
          try {
            const isWin = isWindowsPath(prevLocalPath)
            const prevParts = isWin ? prevLocalPath.split('\\').filter(Boolean) : prevLocalPath.split('/').filter(Boolean)
            const newParts = isWin ? path.split('\\').filter(Boolean) : path.split('/').filter(Boolean)
            const isGoingUp = newParts.length < prevParts.length

            if (isGoingUp) {
              const depthDiff = prevParts.length - newParts.length
              const currentRemotePath = getStoreState().remotePath(sessionId)
              const remoteParts = currentRemotePath.split('/').filter(Boolean)
              const removeLevels = Math.min(depthDiff, remoteParts.length)
              const newRemoteParts = remoteParts.slice(0, remoteParts.length - removeLevels)
              await loadRemoteFiles(newRemoteParts.length === 0 ? '/' : `/${newRemoteParts.join('/')}`, true)
            } else {
              // Going deeper: extract entered directory name
              const enteredDir = newParts[newParts.length - 1]
              if (enteredDir) {
                const currentRemotePath = getStoreState().remotePath(sessionId)
                const currentRemoteFiles = getStoreState().remoteFiles(sessionId)
                const remoteHasDir = currentRemoteFiles.some(f => f.name === enteredDir && f.type === 'directory')
                if (remoteHasDir) {
                  await loadRemoteFiles(joinPath(currentRemotePath, enteredDir, false), true)
                } else {
                  // Target directory doesn't exist on remote side
                  setIsSyncMode(false)
                  toast.info('동기화 해제', `'${enteredDir}' 디렉토리가 원격에 없어 동기화가 해제되었습니다.`)
                }
              }
            }
          } finally {
            syncTriggeredRef.current = false
          }
        }
      } else {
        toast.error('Failed to load local files', result.error || 'Unknown error')
        store.setLocalPath(sessionId, prevLocalPath)
      }
    } catch (error) {
      console.error('Failed to load local files:', error)
      toast.error('Failed to load local files', error instanceof Error ? error.message : 'Unknown error')
      store.setLocalPath(sessionId, prevLocalPath)
    } finally {
      setIsLocalLoading(false)
    }
  }

  const isWindowsPath = (path: string) => {
    return /^[A-Za-z]:[\\/]/.test(path)
  }

  const joinPath = (basePath: string, fileName: string, isLocal: boolean) => {
    if (isLocal && isWindowsPath(basePath)) {
      // Windows path
      const separator = '\\'
      return basePath.endsWith(separator) ? `${basePath}${fileName}` : `${basePath}${separator}${fileName}`
    } else {
      // Unix path
      return basePath === '/' ? `/${fileName}` : `${basePath}/${fileName}`
    }
  }

  const generateUniqueName = (fileName: string, existingFiles: FileItem[]): string => {
    const existingNames = new Set(existingFiles.map(f => f.name))
    const dotIndex = fileName.lastIndexOf('.')
    const baseName = dotIndex > 0 ? fileName.slice(0, dotIndex) : fileName
    const extension = dotIndex > 0 ? fileName.slice(dotIndex) : ''

    let counter = 1
    let newName = `${baseName} (${counter})${extension}`
    while (existingNames.has(newName)) {
      counter++
      newName = `${baseName} (${counter})${extension}`
    }
    return newName
  }

  const processTransfer = async (transfer: PendingTransfer, action: OverwriteAction) => {
    if (action === 'skip') return

    // size-diff: compare file sizes, skip if same
    if (action === 'size-diff') {
      const sourceFile = transfer.type === 'upload'
        ? localFiles.find(f => f.name === transfer.fileName)
        : remoteFiles.find(f => f.name === transfer.fileName)
      const targetFile = transfer.type === 'upload'
        ? remoteFiles.find(f => f.name === transfer.fileName)
        : localFiles.find(f => f.name === transfer.fileName)
      if (sourceFile && targetFile && sourceFile.size === targetFile.size) {
        return // Same size, skip
      }
      // Different size, fall through to overwrite
    }

    let targetPath = transfer.type === 'upload' ? transfer.remotePath : transfer.localPath

    if (action === 'rename') {
      const targetFiles = transfer.type === 'upload' ? remoteFiles : localFiles
      const newName = generateUniqueName(transfer.fileName, targetFiles)
      if (transfer.type === 'upload') {
        targetPath = joinPath(remotePath, newName, false)
      } else {
        targetPath = joinPath(localPath, newName, true)
      }
    }

    try {
      if (transfer.type === 'upload') {
        await window.electronAPI.sftpQueueUpload(sessionId, transfer.localPath, targetPath)
        toast.success('Upload queued', transfer.fileName)
      } else {
        await window.electronAPI.sftpQueueDownload(sessionId, transfer.remotePath, targetPath)
        toast.success('Download queued', transfer.fileName)
      }
    } catch (error) {
      console.error('Transfer failed:', error)
      toast.error('Transfer failed', `${transfer.fileName}: ${error instanceof Error ? error.message : 'Unknown error'}`)
    }
  }

  const processNextTransfer = async (transfers: PendingTransfer[], index: number) => {
    if (index >= transfers.length) {
      // All transfers processed, refresh file lists
      await loadRemoteFiles(remotePath)
      await loadLocalFiles(localPath)
      setPendingTransfers([])
      setCurrentTransferIndex(0)
      setGlobalOverwriteAction(null)
      return
    }

    const transfer = transfers[index]
    const targetFiles = transfer.type === 'upload' ? remoteFiles : localFiles
    const fileExists = targetFiles.some(f => f.name === transfer.fileName)

    if (fileExists && !globalOverwriteAction) {
      // Show modal for conflict
      setConflictFileName(transfer.fileName)
      setOverwriteModalOpen(true)
    } else {
      // No conflict or global action set, proceed
      await processTransfer(transfer, globalOverwriteAction || 'overwrite')
      await processNextTransfer(transfers, index + 1)
    }
  }

  const handleOverwriteConfirm = async (action: OverwriteAction, applyToAll: boolean) => {
    setOverwriteModalOpen(false)

    if (applyToAll) {
      setGlobalOverwriteAction(action)
    }

    const transfer = pendingTransfers[currentTransferIndex]
    await processTransfer(transfer, action)

    const nextIndex = currentTransferIndex + 1
    setCurrentTransferIndex(nextIndex)

    if (applyToAll) {
      // Process remaining with global action
      for (let i = nextIndex; i < pendingTransfers.length; i++) {
        await processTransfer(pendingTransfers[i], action)
      }
      // All done, refresh
      await loadRemoteFiles(remotePath)
      await loadLocalFiles(localPath)
      setPendingTransfers([])
      setCurrentTransferIndex(0)
      setGlobalOverwriteAction(null)
    } else {
      await processNextTransfer(pendingTransfers, nextIndex)
    }
  }

  const handleDropOnLocal = async (fileNames: string[]) => {
    const transfers: PendingTransfer[] = []
    for (const fileName of fileNames) {
      const file = remoteFiles.find(f => f.name === fileName)
      if (file && file.type === 'file') {
        transfers.push({
          type: 'download',
          fileName,
          localPath: joinPath(localPath, fileName, true),
          remotePath: joinPath(remotePath, fileName, false)
        })
      }
    }
    if (transfers.length === 0) return
    setPendingTransfers(transfers)
    setCurrentTransferIndex(0)
    setGlobalOverwriteAction(null)
    await processNextTransfer(transfers, 0)
  }

  const handleDropOnRemote = async (fileNames: string[]) => {
    const transfers: PendingTransfer[] = []
    const directories: string[] = []

    for (const fileName of fileNames) {
      const file = localFiles.find(f => f.name === fileName)
      if (!file) continue
      if (file.type === 'directory') {
        directories.push(fileName)
      } else {
        transfers.push({
          type: 'upload',
          fileName,
          localPath: joinPath(localPath, fileName, true),
          remotePath: joinPath(remotePath, fileName, false)
        })
      }
    }

    for (const dirName of directories) {
      try {
        const localDir = joinPath(localPath, dirName, true)
        const remoteDir = joinPath(remotePath, dirName, false)
        await window.electronAPI.sftpUploadDirectory?.(sessionId, localDir, remoteDir)
        toast.success('폴더 업로드 완료', dirName)
      } catch (error) {
        toast.error('폴더 업로드 실패', `${dirName}: ${error instanceof Error ? error.message : 'Unknown error'}`)
      }
    }

    if (transfers.length > 0) {
      setPendingTransfers(transfers)
      setCurrentTransferIndex(0)
      setGlobalOverwriteAction(null)
      await processNextTransfer(transfers, 0)
    } else if (directories.length > 0) {
      await loadRemoteFiles(remotePath)
    }
  }

  const handleUpload = async () => {
    if (selectedLocal.size === 0) {
      toast.info('업로드할 파일 선택', '왼쪽 로컬 목록에서 업로드할 파일을 먼저 선택하세요')
      return
    }

    const transfers: PendingTransfer[] = []
    const directories: string[] = []

    for (const fileName of selectedLocal) {
      const file = localFiles.find(f => f.name === fileName)
      if (!file) continue
      if (file.type === 'directory') {
        directories.push(fileName)
      } else {
        transfers.push({
          type: 'upload',
          fileName,
          localPath: joinPath(localPath, fileName, true),
          remotePath: joinPath(remotePath, fileName, false)
        })
      }
    }

    // Upload directories recursively
    for (const dirName of directories) {
      try {
        const localDir = joinPath(localPath, dirName, true)
        const remoteDir = joinPath(remotePath, dirName, false)
        await window.electronAPI.sftpUploadDirectory?.(sessionId, localDir, remoteDir)
        toast.success('폴더 업로드 완료', dirName)
      } catch (error) {
        toast.error('폴더 업로드 실패', `${dirName}: ${error instanceof Error ? error.message : 'Unknown error'}`)
      }
    }

    // Upload individual files
    if (transfers.length > 0) {
      setPendingTransfers(transfers)
      setCurrentTransferIndex(0)
      setGlobalOverwriteAction(null)
      await processNextTransfer(transfers, 0)
    } else if (directories.length > 0) {
      // Refresh after directory uploads
      await loadRemoteFiles(remotePath)
    }
  }

  const handleDeleteRemote = async () => {
    const changed = await deleteRemoteSelection(sessionId, remotePath, selectedRemote, remoteFiles)
    if (changed) {
      store.clearRemoteSelection(sessionId)
      await loadRemoteFiles(remotePath)
    }
  }

  const handleDownload = async () => {
    if (selectedRemote.size === 0) {
      toast.info('다운로드할 파일 선택', '오른쪽 원격 목록에서 다운로드할 파일을 먼저 선택하세요')
      return
    }

    const transfers: PendingTransfer[] = []
    for (const fileName of selectedRemote) {
      const file = remoteFiles.find(f => f.name === fileName)
      if (file && file.type === 'file') {
        transfers.push({
          type: 'download',
          fileName,
          localPath: joinPath(localPath, fileName, true),
          remotePath: joinPath(remotePath, fileName, false)
        })
      }
    }

    if (transfers.length === 0) {
      toast.info('폴더는 다운로드할 수 없습니다', '파일을 선택해 주세요. 폴더 다운로드는 아직 지원하지 않습니다')
      return
    }

    setPendingTransfers(transfers)
    setCurrentTransferIndex(0)
    setGlobalOverwriteAction(null)
    await processNextTransfer(transfers, 0)
  }

  const handleClose = () => {
    store.setOpen(sessionId, false)
  }

  if (!isOpen) return null

  return (
    <div
      ref={panelRef}
      className={`sftp-panel ${isResizing || isTransferResizing ? 'resizing' : ''}`}
      style={{ height: panelHeight }}
      onDragOver={(e) => { if (e.dataTransfer.types.includes('Files') || e.dataTransfer.types.includes('application/json')) e.stopPropagation() }}
      onDrop={(e) => { if (e.dataTransfer.types.includes('Files') || e.dataTransfer.types.includes('application/json')) e.stopPropagation() }}
    >
      {/* Resize Handle */}
      <div className="sftp-resize-handle" onMouseDown={handleMouseDown}>
        <RxDragHandleDots2 size={16} />
      </div>

      <div className="sftp-header">
        <span className="sftp-title">SFTP</span>
        <div className="sftp-actions" {...keepSelectionProps}>
          <button
            className={`sftp-btn sync-btn ${isSyncMode ? 'active' : ''}`}
            onClick={() => setIsSyncMode(!isSyncMode)}
            title={isSyncMode ? '디렉토리 동기화 해제' : '디렉토리 동기화'}
          >
            {isSyncMode ? <RiLinkM size={18} /> : <RiLinkUnlinkM size={18} />}
          </button>
          <button className="sftp-btn" onClick={handleUpload} title="업로드: 선택한 로컬 파일을 현재 원격 폴더로">
            <RiUploadFill size={18} />
          </button>
          <button className="sftp-btn" onClick={handleDownload} title="다운로드: 선택한 원격 파일을 현재 로컬 폴더로">
            <RiDownloadFill size={18} />
          </button>
          <button
            className={`sftp-btn transfer-queue-toggle ${transferQueue.isVisible ? 'active' : ''}`}
            onClick={transferQueue.toggle}
            title={transferQueue.isVisible ? '전송 큐 닫기' : '전송 큐 보기'}
            aria-pressed={transferQueue.isVisible}
          >
            <RiArrowUpDownLine size={18} />
            {transferQueue.pendingCount > 0 && <span className="transfer-queue-badge">{transferQueue.pendingCount}</span>}
          </button>
          <button className="sftp-btn" onClick={handlePopOut} title="새 창으로 열기">
            <RiExternalLinkFill size={18} />
          </button>
          <button className="sftp-btn" onClick={handleClose} title="SFTP 닫기">
            <RiCloseFill size={18} />
          </button>
        </div>
      </div>

      <div className="sftp-content">
        <div className="sftp-pane local-pane">
          <div className="pane-header">
            <PathBar
              path={localPath}
              onNavigate={loadLocalFiles}
              type="local"
              label="로컬"
              sessionId={sessionId}
            />
            <button className="refresh-btn" onClick={() => loadLocalFiles(localPath)}>
              <RiRefreshFill size={18} />
            </button>
          </div>
          <FileList
            files={localFiles}
            selected={selectedLocal}
            onNavigate={(path) => loadLocalFiles(path)}
            currentPath={localPath}
            type="local"
            sessionId={sessionId}
            onUpload={handleUpload}
            onDrop={handleDropOnLocal}
            isLoading={isLocalLoading}
          />
        </div>

        <div className={`sftp-divider ${isSyncMode ? 'is-synced' : ''}`}>
          {/* Sync-mode badge centered between the local and remote lists; click to turn sync off */}
          {isSyncMode && (
            <button
              type="button"
              className="sftp-sync-indicator"
              onClick={() => setIsSyncMode(false)}
              title="디렉토리 동기화 중 (클릭하여 해제)"
              aria-label="디렉토리 동기화 켜짐, 클릭하여 해제"
            >
              <RiLinkM size={16} />
            </button>
          )}
        </div>

        <div className="sftp-pane remote-pane">
          <div className="pane-header">
            <PathBar
              path={remotePath}
              onNavigate={loadRemoteFiles}
              type="remote"
              label="원격"
              sessionId={sessionId}
            />
            <button className="refresh-btn" onClick={() => loadRemoteFiles(remotePath)}>
              <RiRefreshFill size={18} />
            </button>
          </div>
          <FileList
            files={remoteFiles}
            selected={selectedRemote}
            onNavigate={(path) => loadRemoteFiles(path)}
            currentPath={remotePath}
            type="remote"
            sessionId={sessionId}
            onDownload={handleDownload}
            onDelete={handleDeleteRemote}
            onDrop={handleDropOnRemote}
            isLoading={isRemoteLoading}
          />
        </div>
      </div>

      {/* Transfer queue: hidden until a transfer starts or the user opens it */}
      {transferQueue.isVisible && (
        <>
          <div
            className="transfer-resize-handle"
            onMouseDown={(e) => { e.preventDefault(); setIsTransferResizing(true) }}
          />
          <div style={{ height: transferHeight, minHeight: 60, overflow: 'hidden' }}>
            <TransferQueue sessionId={sessionId} onClose={transferQueue.hide} />
          </div>
        </>
      )}

      <OverwriteModal
        open={overwriteModalOpen}
        fileName={conflictFileName}
        onClose={() => {
          setOverwriteModalOpen(false)
          setPendingTransfers([])
          setCurrentTransferIndex(0)
          setGlobalOverwriteAction(null)
        }}
        onConfirm={handleOverwriteConfirm}
      />
    </div>
  )
}
