import { useSftpStore, Transfer } from '../../stores/sftpStore'
import { RiCheckboxCircleFill, RiErrorWarningFill, RiPauseFill, RiPlayFill, RiCloseFill, RiDeleteBinFill } from 'react-icons/ri'

const LOCAL_WRITE_DENIED = /\b(EPERM|EACCES)\b/

/** A next step for errors whose raw message does not say what to do. */
function getErrorHint(transfer: Transfer): string | null {
  if (transfer.type === 'download' && transfer.error && LOCAL_WRITE_DENIED.test(transfer.error)) {
    return '이 로컬 폴더에는 새 파일을 만들 권한이 없습니다. C:\\ 같은 드라이브 루트 대신 문서나 다운로드 폴더를 선택하세요.'
  }
  return null
}

interface TransferQueueProps {
  sessionId: string
  /** Hide the queue panel (the SFTP toolbar button shows it again) */
  onClose?: () => void
}

/** Transfer list view. Queue sync with the main process lives in useTransferQueue. */
export function TransferQueue({ sessionId, onClose }: TransferQueueProps) {
  const store = useSftpStore()
  const transfers = store.transfers(sessionId)

  const formatSpeed = (bytesPerSec: number) => {
    if (bytesPerSec < 1024) return `${bytesPerSec} B/s`
    if (bytesPerSec < 1024 * 1024) return `${(bytesPerSec / 1024).toFixed(1)} KB/s`
    return `${(bytesPerSec / (1024 * 1024)).toFixed(1)} MB/s`
  }

  const getStatusIcon = (transfer: Transfer) => {
    switch (transfer.status) {
      case 'completed': return <RiCheckboxCircleFill size={16} className="text-success" />
      case 'error': return <RiErrorWarningFill size={16} className="text-error" />
      case 'paused': return <RiPauseFill size={16} className="text-warning" />
      default: return null
    }
  }

  const getStatusText = (transfer: Transfer) => {
    if (transfer.status === 'active') return formatSpeed(transfer.speed)
    if (transfer.status === 'error' && transfer.error) {
      const errorMap: Record<string, string> = {
        'Permission denied': '권한 거부됨',
        'No such file': '파일 없음',
        'EACCES': '접근 거부됨',
        'EPERM': '쓰기 권한 없음'
      }
      for (const [key, value] of Object.entries(errorMap)) {
        if (transfer.error.includes(key)) return value
      }
      return '오류'
    }
    const statusMap: Record<string, string> = {
      'queued': '대기 중',
      'paused': '일시정지',
      'completed': '완료',
      'error': '오류'
    }
    return statusMap[transfer.status] || transfer.status
  }

  const handlePause = async (transferId: string) => {
    await window.electronAPI.sftpTransferPause(sessionId, transferId)
  }

  const handleResume = async (transferId: string) => {
    await window.electronAPI.sftpTransferResume(sessionId, transferId)
  }

  const handleCancel = async (transferId: string) => {
    await window.electronAPI.sftpTransferCancel(sessionId, transferId)
  }

  const handleClearCompleted = async () => {
    await window.electronAPI.sftpQueueClearCompleted(sessionId)
  }

  const hasCompletedOrError = transfers.some(t => t.status === 'completed' || t.status === 'error')

  return (
    <div className="transfer-queue">
      <div className="transfer-header">
        <span>전송 큐 ({transfers.filter(t => t.status === 'active' || t.status === 'queued').length})</span>
        <div className="transfer-header-actions">
          {hasCompletedOrError && (
            <button
              className="transfer-clear-btn"
              onClick={handleClearCompleted}
              title="완료된 항목 삭제"
            >
              <RiDeleteBinFill size={16} />
            </button>
          )}
          {onClose && (
            <button className="transfer-clear-btn" onClick={onClose} title="전송 큐 닫기" aria-label="전송 큐 닫기">
              <RiCloseFill size={16} />
            </button>
          )}
        </div>
      </div>
      {transfers.length === 0 && (
        <div className="transfer-empty">전송 내역이 없습니다. 파일을 업로드하거나 다운로드하면 여기에 표시됩니다.</div>
      )}
      <div className="transfer-list">
        {transfers.map((transfer) => (
          <div key={transfer.id} className={`transfer-item ${transfer.status}`}>
            <div className="transfer-info">
              <span className="transfer-name" title={transfer.fileName}>{transfer.fileName}</span>
              <span className={`transfer-status ${transfer.status}`}>
                {getStatusIcon(transfer)}
                {getStatusText(transfer)}
              </span>
            </div>
            <div className="transfer-progress-bar">
              <div className="transfer-progress-fill" style={{ width: `${transfer.progress}%` }} />
            </div>
            {transfer.status === 'error' && transfer.error && (
              <div className="transfer-error">
                <p className="transfer-error-message">{transfer.error}</p>
                {getErrorHint(transfer) && <p className="transfer-error-hint">{getErrorHint(transfer)}</p>}
              </div>
            )}
            <div className="transfer-actions">
              {transfer.status === 'active' && (
                <button
                  className="transfer-action-btn"
                  onClick={() => handlePause(transfer.id)}
                  title="일시정지"
                >
                  <RiPauseFill size={16} />
                </button>
              )}
              {transfer.status === 'paused' && (
                <button
                  className="transfer-action-btn"
                  onClick={() => handleResume(transfer.id)}
                  title="재개"
                >
                  <RiPlayFill size={16} />
                </button>
              )}
              {(transfer.status === 'active' || transfer.status === 'paused' || transfer.status === 'queued') && (
                <button
                  className="transfer-action-btn cancel"
                  onClick={() => handleCancel(transfer.id)}
                  title="취소"
                >
                  <RiCloseFill size={16} />
                </button>
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}
