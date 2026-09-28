import { useEffect } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { RiDownload2Fill, RiRefreshLine, RiCloseFill, RiCheckboxCircleFill, RiInformationFill, RiRestartFill } from 'react-icons/ri'
import { useUpdateStore } from '../../stores/updateStore'

export function UpdateNotification() {
  const { info, dismissed, setInfo, setDismissed, setAppVersion } = useUpdateStore()

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
        case 'available':
          setInfo({
            status: 'available',
            version: data.version,
            releaseDate: data.releaseDate,
            releaseNotes: data.releaseNotes
          })
          break
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
        case 'error':
          setInfo({ status: 'error', errorMessage: data.message })
          break
      }
    })

    return () => { cleanup?.() }
  }, [])

  const handleDownload = async () => {
    setInfo({ status: 'downloading', percent: 0 })
    await window.electronAPI.downloadUpdate?.()
  }

  const handleInstall = () => {
    window.electronAPI.installUpdate?.()
  }

  const handleDismiss = () => {
    setDismissed(true)
  }

  const formatBytes = (bytes: number) => {
    if (bytes < 1024) return `${bytes} B`
    if (bytes < 1048576) return `${(bytes / 1024).toFixed(1)} KB`
    return `${(bytes / 1048576).toFixed(1)} MB`
  }

  const showNotification = !dismissed && (
    info.status === 'available' ||
    info.status === 'downloading' ||
    info.status === 'downloaded'
  )

  return (
    <AnimatePresence>
      {showNotification && (
        <motion.div
          className="update-notification"
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
              <button className="update-action-btn update-download-btn" onClick={handleDownload}>
                <RiDownload2Fill size={16} />
                다운로드
              </button>
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

          {info.status === 'downloaded' && (
            <>
              <div className="update-icon update-icon-ready">
                <RiCheckboxCircleFill size={18} />
              </div>
              <div className="update-content">
                <span className="update-text">
                  v{info.version} 다운로드 완료. 재시작하여 설치하세요.
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
    useUpdateStore.getState().setInfo({ status: 'checking' })
    await window.electronAPI.checkForUpdates?.()
  }

  return (
    <div className="version-info" onClick={handleCheck} title="업데이트 확인">
      <span>v{appVersion}</span>
      {info.status === 'checking' && <RiRefreshLine size={16} className="spinning" />}
      {info.status === 'available' && <span className="version-badge">NEW</span>}
      {info.status === 'downloaded' && <span className="version-badge ready">READY</span>}
    </div>
  )
}
