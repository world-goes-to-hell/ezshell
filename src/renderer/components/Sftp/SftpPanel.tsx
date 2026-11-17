import { useEffect, useState, useRef, useCallback } from 'react'
import { perFrame } from '../../lib/throttle'
import { useSftpStore } from '../../stores/sftpStore'
import { FileList, keepSelectionProps } from './FileList'
import { openRemoteFileWindow } from '../../lib/remoteFileOpen'
import { TransferQueue } from './TransferQueue'
import { PathBar } from './PathBar'
import { OverwriteModal } from './OverwriteModal'
import { toast } from '../../stores/toastStore'
import { RiCloseFill, RiUploadFill, RiDownloadFill, RiRefreshLine, RiExternalLinkFill, RiLinkM, RiLinkUnlinkM, RiArrowUpDownLine } from 'react-icons/ri'
import { RxDragHandleDots2 } from 'react-icons/rx'
import { deleteRemoteSelection } from '../../lib/sftpRemoteDelete'
import { useTransferQueue } from '../../hooks/useTransferQueue'
import { useSftpPaneActions } from '../../hooks/useSftpPaneActions'
import { useTerminalStore } from '../../stores/terminalStore'
import { useReloadOnTransferActivity } from '../../hooks/useReloadOnTransferActivity'
import { SFTP_GOTO_EVENT } from '../../lib/sftpSync'
import { useSftpListProgress } from '../../hooks/useSftpListProgress'
import { useSftpTransferBatch } from '../../hooks/useSftpTransferBatch'
import { useSftpDropTransfers } from '../../hooks/useSftpDropTransfers'

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

  // Transfer queue resize state

  // Directory sync state
  const [isSyncMode, setIsSyncMode] = useState(false)
  const syncTriggeredRef = useRef(false)
  const [isLocalLoading, setIsLocalLoading] = useState(false)
  const [isRemoteLoading, setIsRemoteLoading] = useState(false)
  const remoteLoadingCount = useSftpListProgress(sessionId, remotePath, isRemoteLoading)

  // Resize handlers
  // The whole top bar is the resize handle (a separate strip above it cost height). Presses on its
  // buttons are not a resize. `grabOffset` is where in the bar the press landed, so the panel's top
  // edge does not jump to the pointer when the drag starts.
  const grabOffset = useRef(0)
  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    if (e.button !== 0 || (e.target as Element).closest('button, .sftp-actions')) return
    e.preventDefault()
    grabOffset.current = e.clientY - e.currentTarget.getBoundingClientRect().top
    setIsResizing(true)
  }, [])

  useEffect(() => {
    // Mouse moves arrive faster than frames: one height update (one render of the panel) per frame
    const applyHeight = perFrame((clientY: number) => {
      const windowHeight = window.innerHeight
      // Measured from the panel's own bottom edge: the status bar is under the panel, so measuring
      // from the window's bottom made the panel jump by that bar's height when a drag started
      const bottom = panelRef.current?.getBoundingClientRect().bottom ?? windowHeight
      const newHeight = bottom - (clientY - grabOffset.current)
      // Clamp height between 150 and 80% of window height
      const clampedHeight = Math.max(150, Math.min(newHeight, windowHeight * 0.8))
      store.setPanelHeight(sessionId, clampedHeight)
    })
    const handleMouseMove = (e: MouseEvent) => {
      if (!isResizing) return
      applyHeight(e.clientY)
    }

    const handleMouseUp = () => {
      setIsResizing(false)
    }

    if (isResizing) {
      document.addEventListener('mousemove', handleMouseMove)
      document.addEventListener('mouseup', handleMouseUp)
    }

    return () => {
      applyHeight.cancel()
      document.removeEventListener('mousemove', handleMouseMove)
      document.removeEventListener('mouseup', handleMouseUp)
    }
  }, [isResizing, sessionId, store])

  const handlePopOut = async () => {
    // Open SFTP in a new window
    if (window.electronAPI.openSftpWindow) {
      const terminal = useTerminalStore.getState().terminals.get(sessionId)
      const title = terminal?.title || (terminal ? `${terminal.username}@${terminal.host}` : '')
      const result = await window.electronAPI.openSftpWindow(sessionId, localPath, remotePath, title)
      // The window takes over: the docked panel hides until the window closes (lib/sftpDetach.ts brings
      // it back). Hiding only hides: the tab's SFTP connection stays open for the window.
      if (result?.success) store.setOpen(sessionId, false)
    }
  }

  useEffect(() => {
    const initSftp = async () => {
      if (isOpen && sessionId) {
        try {
          const opened = await window.electronAPI.sftpOpen(sessionId)
          // The panel is one element that follows the tab in front, so this runs on every return to a
          // tab. The tab's SFTP channel stays open meanwhile: coming back is not a new connection, and
          // the lists shown before are still there. Only a channel opened now is announced and loaded
          // (the refresh button reloads on demand).
          const isReturn = opened?.alreadyOpen === true
          const state = getStoreState()
          const hasLists = state.remoteFiles(sessionId).length > 0 && state.localFiles(sessionId).length > 0
          if (!isReturn) toast.info('SFTP 연결을 열었습니다')
          if (isReturn && hasLists) return
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

  // The terminal's right-click menu sends the panel to the folder the terminal is in
  useEffect(() => {
    const onGoto = (event: Event) => {
      const { sessionId: target, path } = (event as CustomEvent<{ sessionId: string; path: string }>).detail
      if (target === sessionId && isOpen) void loadRemoteFiles(path)
    }
    window.addEventListener(SFTP_GOTO_EVENT, onGoto)
    return () => window.removeEventListener(SFTP_GOTO_EVENT, onGoto)
  })

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

  const transferBatch = useSftpTransferBatch({
    sessionId,
    localFiles,
    remoteFiles,
    onDone: async () => {
      await loadRemoteFiles(remotePath)
      await loadLocalFiles(localPath)
    }
  })

  // Dropping entries from one list onto the other (shared with the popped-out SFTP window)
  const { dropOnLocal: handleDropOnLocal, dropOnRemote: handleDropOnRemote } = useSftpDropTransfers({
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
    await handleDropOnRemote([...selectedLocal])
  }

  useReloadOnTransferActivity({
    sessionId,
    localPath,
    remotePath,
    reloadLocal: () => loadLocalFiles(localPath),
    reloadRemote: () => loadRemoteFiles(remotePath),
    isBusy: isLocalLoading || isRemoteLoading
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
    await handleDropOnLocal([...selectedRemote])
  }

  const handleClose = () => {
    store.setOpen(sessionId, false)
  }

  if (!isOpen) return null

  return (
    <div
      ref={panelRef}
      className={`sftp-panel ${isResizing ? 'resizing' : ''}`}
      style={{ height: panelHeight }}
      onDragOver={(e) => { if (e.dataTransfer.types.includes('Files') || e.dataTransfer.types.includes('application/json')) e.stopPropagation() }}
      onDrop={(e) => { if (e.dataTransfer.types.includes('Files') || e.dataTransfer.types.includes('application/json')) e.stopPropagation() }}
    >
      {/* Top bar: label, buttons, and the handle that resizes the panel (drag it up or down) */}
      <div className="sftp-header" onMouseDown={handleMouseDown} title="끌어서 SFTP 패널 높이 조절">
        <span className="sftp-title">SFTP</span>
        <span className="sftp-header-grip" aria-hidden="true">
          <RxDragHandleDots2 size={16} />
        </span>
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
            onOpenFile={(file, mode) => {
              const terminal = useTerminalStore.getState().terminals.get(sessionId)
              const name = terminal?.title || (terminal ? `${terminal.username}@${terminal.host}` : '')
              void openRemoteFileWindow(sessionId, name, remotePath, file.name, mode)
            }}
            onDrop={handleDropOnRemote}
            isLoading={isRemoteLoading}
            loadingCount={remoteLoadingCount}
          />
        </div>
      </div>

      {/* Transfer queue: hidden until a transfer starts or the user opens it */}
      {transferQueue.isVisible && (
        <TransferQueue
          sessionId={sessionId}
          onClose={transferQueue.hide}
          // The queue's header was dragged higher than the panel allows: the panel grows with it
          onNeedRoom={needed => { if (needed > panelHeight) store.setPanelHeight(sessionId, Math.min(needed, window.innerHeight * 0.8)) }}
        />
      )}

      <OverwriteModal {...transferBatch.overwriteModalProps} />
    </div>
  )
}
