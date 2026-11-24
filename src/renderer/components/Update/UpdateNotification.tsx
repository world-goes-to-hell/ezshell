import { useEffect, useRef } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { RiDownload2Fill, RiRefreshLine, RiCloseFill, RiCheckboxCircleFill, RiInformationFill, RiRestartFill, RiExternalLinkLine, RiErrorWarningLine } from 'react-icons/ri'
import { useUpdateStore } from '../../stores/updateStore'
import { toast } from '../../stores/toastStore'
import { isUpdateNoticeVisible, resolveDownloadFailure, resolveManualCheck, type UpdateCheckResult, type UpdateDownloadResult } from '../../lib/updateCheck'
import { installUpdateKeepingTabs } from '../../lib/updateInstall'

export function UpdateNotification() {
  const { info, dismissedKey, setInfo, dismissCurrent, setAppVersion } = useUpdateStore()
  const downloadPending = useRef(false)

  useEffect(() => {
    // Get app version
    window.electronAPI.getAppVersion?.().then((version: string) => {
      if (version) setAppVersion(version)
    }).catch(() => {})

    // Listen for update status
    const cleanup = window.electronAPI.onUpdateStatus?.((data: any) => {
      switch (data.status) {
        case 'checking':
          setInfo({ status: 'checking' })
          break
        case 'available': {
          const current = useUpdateStore.getState().info
          if (current.status === 'downloading' || (current.status === 'download-error' && current.version === data.version)) break
          setInfo({
            status: 'available',
            version: data.version,
            releaseDate: data.releaseDate,
            releaseNotes: data.releaseNotes,
            manual: data.manual === true
          })
          break
        }
        case 'not-available':
          setInfo({ status: 'not-available' })
          break
        case 'downloading':
          setInfo({
            status: 'downloading',
            percent: data.percent,
            transferred: data.transferred,
            total: data.total,
            bytesPerSecond: data.bytesPerSecond
          })
          break
        case 'downloaded':
          setInfo({ status: 'downloaded', version: data.version })
          break
        case 'error': {
          const status = useUpdateStore.getState().info.status
          if (downloadPending.current || status === 'download-error') break
          setInfo(resolveDownloadFailure(status, { success: false, error: data.message })
            ?? { status: 'error', errorMessage: data.message })
          break
        }
      }
    })

    return () => { cleanup?.() }
  }, [])

  const handleDownload = async () => {
    const state = useUpdateStore.getState()
    if (downloadPending.current || (state.info.status !== 'available' && state.info.status !== 'download-error')) return
    downloadPending.current = true
    state.clearDismissed()
    setInfo({ status: 'downloading', percent: 0, bytesPerSecond: undefined, errorMessage: undefined })
    let result: UpdateDownloadResult | undefined
    try {
      result = await window.electronAPI.downloadUpdate?.()
    } catch (error) {
      result = { success: false, error: error instanceof Error ? error.message : String(error) }
    } finally {
      downloadPending.current = false
    }
    const failure = resolveDownloadFailure(useUpdateStore.getState().info.status, result)
    if (failure) setInfo(failure)
  }

  const handleOpenPage = async () => {
    try {
      const result = await window.electronAPI.openUpdatePage?.()
      if (!result?.success) toast.error('업데이트', '릴리스 페이지를 열지 못했습니다.')
    } catch {
      toast.error('업데이트', '릴리스 페이지를 열지 못했습니다.')
    }
  }

  // Checks what the restart would cut off and writes the open tabs down first (lib/updateInstall.ts)
  const handleInstall = () => {
    void installUpdateKeepingTabs().catch(() => toast.error('업데이트', '업데이트를 시작하지 못했습니다.'))
  }

  const handleDismiss = () => {
    dismissCurrent()
  }

  const formatBytes = (bytes: number) => {
    if (bytes < 1024) return `${bytes} B`
    if (bytes < 1048576) return `${(bytes / 1024).toFixed(1)} KB`
    return `${(bytes / 1048576).toFixed(1)} MB`
  }

  const showNotification = isUpdateNoticeVisible(info, dismissedKey)

  return (
    <AnimatePresence>
      {showNotification && (
        <motion.div
          className={`update-notification${info.status === 'download-error' ? ' is-error' : ''}`}
          initial={{ opacity: 0, y: 20, scale: 0.95 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          exit={{ opacity: 0, y: 20, scale: 0.95 }}
          transition={{ duration: 0.3 }}
        >
          {info.status === 'available' && (
            <>
              <div className="update-icon update-icon-info">
                <RiInformationFill size={18} />
              </div>
              <div className="update-content">
                <span className="update-text">
                  새 버전 <strong>v{info.version}</strong> 사용 가능
                </span>
              </div>
              {info.manual ? (
                <button className="update-action-btn update-download-btn" onClick={() => void handleOpenPage()} title="브라우저에서 다운로드 페이지를 엽니다">
                  <RiExternalLinkLine size={16} />
                  다운로드 페이지
                </button>
              ) : (
                <button className="update-action-btn update-download-btn" onClick={handleDownload}>
                  <RiDownload2Fill size={16} />
                  다운로드
                </button>
              )}
              <button className="update-dismiss-btn" onClick={handleDismiss}>
                <RiCloseFill size={16} />
              </button>
            </>
          )}

          {info.status === 'downloading' && (
            <>
              <div className="update-icon update-icon-downloading">
                <RiDownload2Fill size={18} />
              </div>
              <div className="update-content">
                <span className="update-text">업데이트 다운로드 중...</span>
                <div className="update-progress-bar">
                  <div
                    className="update-progress-fill"
                    style={{ width: `${info.percent || 0}%` }}
                  />
                </div>
                <span className="update-progress-text">
                  {info.percent?.toFixed(0)}%
                  {info.bytesPerSecond ? ` · ${formatBytes(info.bytesPerSecond)}/s` : ''}
                </span>
              </div>
            </>
          )}

          {info.status === 'download-error' && (
            <>
              <div className="update-icon update-icon-error" aria-hidden="true">
                <RiErrorWarningLine size={18} />
              </div>
              <div className="update-content">
                <div role="alert" className="update-text">업데이트를 다운로드하지 못했습니다.</div>
                {info.errorMessage && <div className="update-error-detail" title={info.errorMessage}>{info.errorMessage}</div>}
                <div className="update-error-actions">
                  <button type="button" className="update-action-btn update-download-btn" onClick={handleDownload}>
                    다시 시도
                  </button>
                  <button type="button" className="update-action-btn update-page-btn" onClick={() => void handleOpenPage()}>
                    <RiExternalLinkLine size={16} aria-hidden="true" /> 릴리스 목록
                  </button>
                </div>
              </div>
              <button type="button" className="update-dismiss-btn" onClick={handleDismiss} aria-label="다운로드 오류 알림 닫기">
                <RiCloseFill size={16} aria-hidden="true" />
              </button>
            </>
          )}

          {info.status === 'downloaded' && (
            <>
              <div className="update-icon update-icon-ready">
                <RiCheckboxCircleFill size={18} />
              </div>
              <div className="update-content">
                <span className="update-text">
                  v{info.version} 다운로드 완료. 재시작해도 열린 탭은 잠금을 푼 뒤 다시 열 수 있습니다.
                </span>
              </div>
              <button className="update-action-btn update-install-btn" onClick={handleInstall}>
                <RiRestartFill size={16} />
                재시작
              </button>
              <button className="update-dismiss-btn" onClick={handleDismiss}>
                <RiCloseFill size={16} />
              </button>
            </>
          )}
        </motion.div>
      )}
    </AnimatePresence>
  )
}

// Footer version display with manual check
export function VersionInfo() {
  const { appVersion, info } = useUpdateStore()

  const handleCheck = async () => {
    const state = useUpdateStore.getState()
    if (state.info.status === 'downloading') return
    state.clearDismissed()
    if (state.info.status === 'download-error') return
    // A second click while checking is fine: electron-updater joins the check already in progress
    state.setInfo({ status: 'checking' })
    let result: UpdateCheckResult | undefined
    try {
      result = await window.electronAPI.checkForUpdates?.()
    } catch (error) {
      result = { success: false, error: error instanceof Error ? error.message : String(error) }
    }
    const { info: settled, notice } = resolveManualCheck(useUpdateStore.getState().info.status, result)
    if (settled) useUpdateStore.getState().setInfo(settled)
    if (notice) toast[notice.type](notice.title, notice.message)
  }

  return (
    <button type="button" className="version-info" onClick={handleCheck}
      title={info.status === 'download-error' ? '업데이트 다운로드 오류 보기' : '업데이트 확인'}>
      <span>v{appVersion}</span>
      {info.status === 'checking' && <RiRefreshLine size={16} className="spinning" />}
      {info.status === 'available' && <span className="version-badge">NEW</span>}
      {info.status === 'downloaded' && <span className="version-badge ready">READY</span>}
      {info.status === 'download-error' && <RiErrorWarningLine size={16} className="version-update-error" role="img" aria-label="업데이트 다운로드 실패" />}
    </button>
  )
}
