import { useEffect, useState } from 'react'
import { useSftpStore, FileItem } from '../../stores/sftpStore'
import { FileList } from './FileList'
import { TransferQueue } from './TransferQueue'
import { PathBar } from './PathBar'
import { OverwriteModal, OverwriteAction } from './OverwriteModal'
import { RiUploadFill, RiDownloadFill, RiRefreshFill, RiSubtractFill, RiCheckboxBlankFill, RiCloseFill } from 'react-icons/ri'

interface PendingTransfer {
  type: 'upload' | 'download'
  fileName: string
  localPath: string
  remotePath: string
}

interface SftpWindowProps {
  sessionId: string
  initialLocalPath: string
  initialRemotePath: string
}

export function SftpWindow({ sessionId, initialLocalPath, initialRemotePath }: SftpWindowProps) {
  const store = useSftpStore()

  // Get session-specific state
  const remotePath = store.remotePath(sessionId)
  const remoteFiles = store.remoteFiles(sessionId)
  const localPath = store.localPath(sessionId)
  const localFiles = store.localFiles(sessionId)
  const selectedRemote = store.selectedRemote(sessionId)
  const selectedLocal = store.selectedLocal(sessionId)

  // Overwrite modal state
  const [overwriteModalOpen, setOverwriteModalOpen] = useState(false)
  const [conflictFileName, setConflictFileName] = useState('')
  const [pendingTransfers, setPendingTransfers] = useState<PendingTransfer[]>([])
  const [currentTransferIndex, setCurrentTransferIndex] = useState(0)
  const [globalOverwriteAction, setGlobalOverwriteAction] = useState<OverwriteAction | null>(null)

  useEffect(() => {
    const initSftp = async () => {
      try {
        // SFTP session should already be open from main window
        await loadRemoteFiles(initialRemotePath || '/')
        await loadLocalFiles(initialLocalPath || getDefaultLocalPath())
      } catch (error) {
        console.error('Failed to initialize SFTP window:', error)
      }
    }
    initSftp()
  }, [sessionId])

  const getDefaultLocalPath = () => {
    const isWindows = navigator.platform.toLowerCase().includes('win') ||
                      navigator.userAgent.toLowerCase().includes('windows')
    return isWindows ? 'C:\\' : '/'
  }

  const loadRemoteFiles = async (path: string) => {
    try {
      const rawFiles = await window.electronAPI.sftpList(sessionId, path)
      const files = (rawFiles || []).map((f: any) => ({
        name: f.name,
        type: f.isDirectory ? 'directory' : 'file',
        size: f.size,
        modifyTime: f.mtime,
        permissions: f.permissions
      }))
      store.setRemoteFiles(sessionId, files)
      store.setRemotePath(sessionId, path)
    } catch (error) {
      console.error('Failed to load remote files:', error)
    }
  }

  const loadLocalFiles = async (path: string) => {
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
        store.setLocalPath(sessionId, path)
      }
    } catch (error) {
      console.error('Failed to load local files:', error)
    }
  }

  const isWindowsPath = (path: string) => /^[A-Za-z]:[\\/]/.test(path)

  const joinPath = (basePath: string, fileName: string, isLocal: boolean) => {
    if (isLocal && isWindowsPath(basePath)) {
      const separator = '\\'
      return basePath.endsWith(separator) ? `${basePath}${fileName}` : `${basePath}${separator}${fileName}`
    } else {
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

    if (transfer.type === 'upload') {
      await window.electronAPI.sftpQueueUpload(sessionId, transfer.localPath, targetPath)
    } else {
      await window.electronAPI.sftpQueueDownload(sessionId, transfer.remotePath, targetPath)
    }
  }

  const processNextTransfer = async (transfers: PendingTransfer[], index: number) => {
    if (index >= transfers.length) {
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
      setConflictFileName(transfer.fileName)
      setOverwriteModalOpen(true)
    } else {
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
      for (let i = nextIndex; i < pendingTransfers.length; i++) {
        await processTransfer(pendingTransfers[i], action)
      }
      await loadRemoteFiles(remotePath)
      await loadLocalFiles(localPath)
      setPendingTransfers([])
      setCurrentTransferIndex(0)
      setGlobalOverwriteAction(null)
    } else {
      await processNextTransfer(pendingTransfers, nextIndex)
    }
  }

  const handleUpload = async () => {
    if (selectedLocal.size === 0) return

    const transfers: PendingTransfer[] = []
    for (const fileName of selectedLocal) {
      const file = localFiles.find(f => f.name === fileName)
      if (file && file.type === 'file') {
        transfers.push({
          type: 'upload',
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

  const handleDownload = async () => {
    if (selectedRemote.size === 0) return

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

    if (transfers.length === 0) return

    setPendingTransfers(transfers)
    setCurrentTransferIndex(0)
    setGlobalOverwriteAction(null)
    await processNextTransfer(transfers, 0)
  }

  return (
    <div className="sftp-window">
      {/* Title Bar */}
      <div className="title-bar">
        <div className="title-bar-drag">
          <span className="title-bar-title">SFTP - {sessionId.slice(0, 8)}</span>
        </div>
        <div className="title-bar-controls">
          <button className="title-btn" onClick={() => window.electronAPI.minimizeWindow()}>
            <RiSubtractFill size={14} />
          </button>
          <button className="title-btn" onClick={() => window.electronAPI.maximizeWindow()}>
            <RiCheckboxBlankFill size={12} />
          </button>
          <button className="title-btn close" onClick={() => window.electronAPI.closeWindow()}>
            <RiCloseFill size={14} />
          </button>
        </div>
      </div>

      {/* Toolbar */}
      <div className="sftp-toolbar">
        <button className="sftp-btn" onClick={handleUpload} title="Upload">
          <RiUploadFill size={16} />
          <span>업로드</span>
        </button>
        <button className="sftp-btn" onClick={handleDownload} title="Download">
          <RiDownloadFill size={16} />
          <span>다운로드</span>
        </button>
      </div>

      {/* Content */}
      <div className="sftp-window-content">
        <div className="sftp-pane local-pane">
          <div className="pane-header">
            <PathBar
              path={localPath}
              onNavigate={loadLocalFiles}
              type="local"
              label="로컬"
            />
            <button className="refresh-btn" onClick={() => loadLocalFiles(localPath)}>
              <RiRefreshFill size={14} />
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
          />
        </div>

        <div className="sftp-divider" />

        <div className="sftp-pane remote-pane">
          <div className="pane-header">
            <PathBar
              path={remotePath}
              onNavigate={loadRemoteFiles}
              type="remote"
              label="원격"
            />
            <button className="refresh-btn" onClick={() => loadRemoteFiles(remotePath)}>
              <RiRefreshFill size={14} />
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
          />
        </div>
      </div>

      <TransferQueue sessionId={sessionId} />

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
