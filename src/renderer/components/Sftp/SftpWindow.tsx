import { useEffect, useRef, useState } from 'react'
import { useSftpDropTransfers } from '../../hooks/useSftpDropTransfers'
import { localFollowsRemote, remoteFollowsLocal, type SyncMove } from '../../lib/directorySync'
import { useSftpStore } from '../../stores/sftpStore'
import { FileList, keepSelectionProps } from './FileList'
import { openRemoteFileWindow } from '../../lib/remoteFileOpen'
import { TransferQueue } from './TransferQueue'
import { PathBar } from './PathBar'
import { OverwriteModal } from './OverwriteModal'
import { RiUploadFill, RiDownloadFill, RiRefreshLine, RiArrowUpDownLine, RiFolderTransferFill, RiLinkM, RiLinkUnlinkM, RiMergeCellsHorizontal } from 'react-icons/ri'
import { PopoutTitleBar } from '../TitleBar/PopoutTitleBar'
import { usePopoutTheme } from '../../hooks/usePopoutTheme'
import { useSftpListProgress } from '../../hooks/useSftpListProgress'
import { usePopoutHostLabel } from '../../hooks/usePopoutHostLabel'
import { toast } from '../../stores/toastStore'
import { deleteRemoteSelection } from '../../lib/sftpRemoteDelete'
import { useTransferQueue } from '../../hooks/useTransferQueue'
import { useSftpPaneActions } from '../../hooks/useSftpPaneActions'
import { useReloadOnTransferActivity } from '../../hooks/useReloadOnTransferActivity'
import { useSftpTransferBatch } from '../../hooks/useSftpTransferBatch'

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

  // Tell main which folders this window shows, so the docked panel can come back to them
  useEffect(() => {
    if (localPath && remotePath) window.electronAPI.sftpWindowPaths?.(sessionId, localPath, remotePath)
  }, [sessionId, localPath, remotePath])

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

  // The folder being read (null when none): the list shows "불러오는 중…" with the count so far
  const [remoteLoadingPath, setRemoteLoadingPath] = useState<string | null>(null)
  const remoteLoadingCount = useSftpListProgress(sessionId, remoteLoadingPath ?? '', remoteLoadingPath !== null)

  // Directory sync, as in the SFTP panel: moving in one list moves the other the same way
  // (lib/directorySync.ts). The ref is the value the async loaders read; the guard keeps the list that
  // follows from making the first one follow back.
  const [isSyncMode, setIsSyncModeState] = useState(false)
  const syncModeRef = useRef(false)
  const isFollowing = useRef(false)
  const setIsSyncMode = (on: boolean) => {
    syncModeRef.current = on
    setIsSyncModeState(on)
  }

  const follow = async (move: SyncMove, side: '로컬' | '원격', go: (path: string) => Promise<void>) => {
    if (!move) return
    if (move.kind === 'missing') {
      setIsSyncMode(false)
      toast.info('동기화 해제', `'${move.name}' 디렉토리가 ${side}에 없어 동기화가 해제되었습니다.`)
      return
    }
    isFollowing.current = true
    try {
      await go(move.path)
    } finally {
      isFollowing.current = false
    }
  }

  const loadRemoteFiles = async (path: string) => {
    const prevRemotePath = useSftpStore.getState().remotePath(sessionId)
    setRemoteLoadingPath(path)
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
      if (syncModeRef.current && !isFollowing.current) {
        const state = useSftpStore.getState()
        await follow(localFollowsRemote(prevRemotePath, path, state.localPath(sessionId), state.localFiles(sessionId)), '로컬', loadLocalFiles)
      }
    } catch (error) {
      console.error('Failed to load remote files:', error)
    } finally {
      setRemoteLoadingPath(null)
    }
  }

  const loadLocalFiles = async (path: string) => {
    const prevLocalPath = useSftpStore.getState().localPath(sessionId)
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
        if (syncModeRef.current && !isFollowing.current) {
          const state = useSftpStore.getState()
          await follow(remoteFollowsLocal(prevLocalPath, path, state.remotePath(sessionId), state.remoteFiles(sessionId)), '원격', loadRemoteFiles)
        }
      }
    } catch (error) {
      console.error('Failed to load local files:', error)
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

  // Dropping entries from one list onto the other, as in the SFTP panel
  const { dropOnLocal, dropOnRemote } = useSftpDropTransfers({
    sessionId,
    localPath,
    remotePath,
    localFiles,
    remoteFiles,
    startTransfers: transferBatch.start,
    reloadRemote: () => loadRemoteFiles(remotePath),
    reloadLocal: () => loadLocalFiles(localPath)
  })

  // Files and folders alike (the same path as dropping the selection onto the remote list)
  const handleUpload = async () => {
    if (selectedLocal.size === 0) {
      toast.info('업로드할 파일 선택', '왼쪽 로컬 목록에서 업로드할 파일을 먼저 선택하세요')
      return
    }
    await dropOnRemote([...selectedLocal])
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
    await dropOnLocal([...selectedRemote])
  }

  return (
    <div className="sftp-window">
      <PopoutTitleBar
        icon={<RiFolderTransferFill size={16} />}
        title={`SFTP · ${sessionTitle || hostLabel || '연결'}`}
        subtitle={sessionTitle && hostLabel !== sessionTitle ? hostLabel : undefined}
        actions={
          // Closing the window is the merge: main tells the main window, which shows the docked panel again
          <button className="title-bar-btn popout-title-action" onClick={() => window.electronAPI.closeWindow()} title="메인 창으로 병합" aria-label="메인 창으로 병합">
            <RiMergeCellsHorizontal size={16} />
          </button>
        }
      />

      {/* The same bar as the docked SFTP panel: name on the left, the same icon buttons in the same order
          on the right (without the panel's own "new window" and "close") */}
      <div className="sftp-header">
        <span className="sftp-title">SFTP</span>
        <div className="sftp-actions" {...keepSelectionProps}>
          <button
            className={`sftp-btn sync-btn ${isSyncMode ? 'active' : ''}`}
            onClick={() => setIsSyncMode(!isSyncMode)}
            title={isSyncMode ? '디렉토리 동기화 해제' : '디렉토리 동기화'}
            aria-pressed={isSyncMode}
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
        </div>
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
            <button className="refresh-btn" onClick={() => loadLocalFiles(localPath)} title="로컬 목록 새로고침" aria-label="로컬 목록 새로고침">
              <RiRefreshLine size={16} />
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
            onDrop={dropOnLocal}
          />
        </div>

        <div className={`sftp-divider ${isSyncMode ? 'is-synced' : ''}`}>
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
              editRequest={paneActions.pathEditRequest.remote}
            />
            <button className="refresh-btn" onClick={() => loadRemoteFiles(remotePath)} title="원격 목록 새로고침" aria-label="원격 목록 새로고침">
              <RiRefreshLine size={16} />
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
            onDrop={dropOnRemote}
            onOpenFile={(file, mode) => void openRemoteFileWindow(sessionId, sessionTitle || hostLabel || '', remotePath, file.name, mode)}
            isLoading={remoteLoadingPath !== null}
            loadingCount={remoteLoadingCount}
          />
        </div>
      </div>

      {transferQueue.isVisible && <TransferQueue sessionId={sessionId} onClose={transferQueue.hide} />}

      <OverwriteModal {...transferBatch.overwriteModalProps} />
    </div>
  )
}
