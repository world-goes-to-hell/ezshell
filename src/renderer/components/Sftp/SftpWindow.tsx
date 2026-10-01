import { useEffect } from 'react'
import { useSftpStore } from '../../stores/sftpStore'
import { FileList, keepSelectionProps } from './FileList'
import { TransferQueue } from './TransferQueue'
import { PathBar } from './PathBar'
import { OverwriteModal } from './OverwriteModal'
import { RiUploadFill, RiDownloadFill, RiRefreshFill, RiArrowUpDownLine, RiFolderTransferFill } from 'react-icons/ri'
import { PopoutTitleBar } from '../TitleBar/PopoutTitleBar'
import { usePopoutTheme } from '../../hooks/usePopoutTheme'
import { usePopoutHostLabel } from '../../hooks/usePopoutHostLabel'
import { toast } from '../../stores/toastStore'
import { deleteRemoteSelection } from '../../lib/sftpRemoteDelete'
import { useTransferQueue } from '../../hooks/useTransferQueue'
import { useSftpPaneActions } from '../../hooks/useSftpPaneActions'
import { useReloadOnTransferActivity } from '../../hooks/useReloadOnTransferActivity'
import { useSftpTransferBatch, type PendingTransfer } from '../../hooks/useSftpTransferBatch'

interface SftpWindowProps {
  sessionId: string
  initialLocalPath: string
  initialRemotePath: string
  /** Name of the terminal tab the panel was popped out of */
  sessionTitle?: string
}

export function SftpWindow({ sessionId, initialLocalPath, initialRemotePath, sessionTitle }: SftpWindowProps) {
  usePopoutTheme()
  const hostLabel = usePopoutHostLabel(sessionId)
  const store = useSftpStore()
  const transferQueue = useTransferQueue(sessionId)

  // Get session-specific state
  const remotePath = store.remotePath(sessionId)
  const remoteFiles = store.remoteFiles(sessionId)
  const localPath = store.localPath(sessionId)
  const localFiles = store.localFiles(sessionId)
  const selectedRemote = store.selectedRemote(sessionId)
  const selectedLocal = store.selectedLocal(sessionId)

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
        permissions: f.permissions,
        owner: f.owner,
        group: f.group
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

  const transferBatch = useSftpTransferBatch({
    sessionId,
    localFiles,
    remoteFiles,
    onDone: async () => {
      await loadRemoteFiles(remotePath)
      await loadLocalFiles(localPath)
    }
  })

  const handleUpload = async () => {
    if (selectedLocal.size === 0) {
      toast.info('업로드할 파일 선택', '왼쪽 로컬 목록에서 업로드할 파일을 먼저 선택하세요')
      return
    }

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

    await transferBatch.start(transfers)
  }

  useReloadOnTransferActivity({
    sessionId,
    localPath,
    remotePath,
    reloadLocal: () => loadLocalFiles(localPath),
    reloadRemote: () => loadRemoteFiles(remotePath)
  })

  const paneActions = useSftpPaneActions({
    sessionId,
    localPath,
    remotePath,
    localFiles,
    selectedLocal,
    reloadLocal: () => loadLocalFiles(localPath),
    reloadRemote: () => loadRemoteFiles(remotePath),
    clearLocalSelection: () => store.clearLocalSelection(sessionId)
  })

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

    await transferBatch.start(transfers)
  }

  return (
    <div className="sftp-window">
      <PopoutTitleBar
        icon={<RiFolderTransferFill size={16} />}
        title={`SFTP · ${sessionTitle || hostLabel || '연결'}`}
        subtitle={sessionTitle && hostLabel !== sessionTitle ? hostLabel : undefined}
      />

      {/* Toolbar */}
      <div className="sftp-toolbar sftp-window-toolbar" {...keepSelectionProps}>
        <button className="sftp-btn" onClick={handleUpload} title="업로드: 선택한 로컬 파일을 현재 원격 폴더로">
          <RiUploadFill size={18} />
          <span>업로드</span>
        </button>
        <button className="sftp-btn" onClick={handleDownload} title="다운로드: 선택한 원격 파일을 현재 로컬 폴더로">
          <RiDownloadFill size={18} />
          <span>다운로드</span>
        </button>
        <button
          className={`sftp-btn transfer-queue-toggle ${transferQueue.isVisible ? 'active' : ''}`}
          onClick={transferQueue.toggle}
          title={transferQueue.isVisible ? '전송 큐 닫기' : '전송 큐 보기'}
          aria-pressed={transferQueue.isVisible}
        >
          <RiArrowUpDownLine size={18} />
          <span>전송 큐</span>
          {transferQueue.pendingCount > 0 && <span className="transfer-queue-badge">{transferQueue.pendingCount}</span>}
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
              sessionId={sessionId}
              editRequest={paneActions.pathEditRequest.local}
            />
            <button className="refresh-btn" onClick={() => loadLocalFiles(localPath)}>
              <RiRefreshFill size={16} />
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
            onDelete={paneActions.deleteLocal}
            {...paneActions.local}
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
              sessionId={sessionId}
              editRequest={paneActions.pathEditRequest.remote}
            />
            <button className="refresh-btn" onClick={() => loadRemoteFiles(remotePath)}>
              <RiRefreshFill size={16} />
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
            {...paneActions.remote}
          />
        </div>
      </div>

      {transferQueue.isVisible && <TransferQueue sessionId={sessionId} onClose={transferQueue.hide} />}

      <OverwriteModal {...transferBatch.overwriteModalProps} />
    </div>
  )
}
