import { useEffect, useRef, useState } from 'react'
import { RxDragHandleDots2 } from 'react-icons/rx'
import { perFrame } from '../../lib/throttle'
import { QUEUE_HEIGHT_STORAGE_KEY, LISTS_MIN_HEIGHT, clampQueueHeight, maxQueueHeight, parseQueueHeight } from '../../lib/transferQueueHeight'
import { confirmDialog } from '../../stores/confirmStore'
import { toast } from '../../stores/toastStore'

function readQueueHeight(): number {
  try {
    return parseQueueHeight(localStorage.getItem(QUEUE_HEIGHT_STORAGE_KEY))
  } catch {
    return parseQueueHeight(null)
  }
}

import { useSftpStore, Transfer } from '../../stores/sftpStore'
import { RiCheckboxCircleFill, RiErrorWarningFill, RiPauseFill, RiPlayFill, RiCloseFill, RiDeleteBinFill, RiUploadLine, RiDownloadLine, RiRestartLine } from 'react-icons/ri'

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
  /**
   * The drag asks for more height than the container can give: the host may make the container this
   * tall (the bottom panel does; the popped-out window is as tall as its window).
   */
  onNeedRoom?: (containerHeight: number) => void
}

/** Transfer list view. Queue sync with the main process lives in useTransferQueue. */
export function TransferQueue({ sessionId, onClose, onNeedRoom }: TransferQueueProps) {
  const store = useSftpStore()
  const transfers = store.transfers(sessionId)
  const retrying = useRef(new Set<string>())
  const [retryingIds, setRetryingIds] = useState<ReadonlySet<string>>(new Set())

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

  const handleRetry = async (transfer: Transfer) => {
    if (retrying.current.has(transfer.id)) return
    retrying.current.add(transfer.id)
    setRetryingIds(new Set(retrying.current))
    try {
      const api = window.electronAPI
      let result = await api.sftpTransferRetry(sessionId, transfer.id)
      if (result.needsOverwrite) {
        const target = transfer.type === 'download' ? transfer.localPath : transfer.remotePath
        const overwrite = await confirmDialog({
          title: '전송 대상 파일이 이미 있습니다',
          message: `${target}\n파일을 덮어쓰고 다시 전송할까요?`,
          confirmLabel: '덮어쓰고 다시 전송',
          cancelLabel: '취소',
          danger: true
        })
        if (!overwrite) return
        result = await api.sftpTransferRetry(sessionId, transfer.id, true)
      }
      if (result.error) toast.error('다시 전송하지 못했습니다', result.error)
    } catch (error) {
      toast.error('다시 전송하지 못했습니다', error instanceof Error ? error.message : undefined)
    } finally {
      retrying.current.delete(transfer.id)
      setRetryingIds(new Set(retrying.current))
    }
  }

  const handleCancel = async (transferId: string, failedOnly = false) => {
    await window.electronAPI.sftpTransferCancel(sessionId, transferId, failedOnly)
  }

  const handleClearCompleted = async () => {
    await window.electronAPI.sftpQueueClearCompleted(sessionId)
  }

  // Height: dragged by the header, remembered across sessions. Measured from the queue's own bottom
  // edge, and from where in the header the press landed, so nothing jumps when the drag starts.
  const rootRef = useRef<HTMLDivElement>(null)
  const [height, setHeight] = useState(readQueueHeight)
  const [isResizing, setIsResizing] = useState(false)
  const grabOffset = useRef(0)
  const onNeedRoomRef = useRef(onNeedRoom)
  onNeedRoomRef.current = onNeedRoom

  const startResize = (event: React.MouseEvent<HTMLDivElement>) => {
    if (event.button !== 0 || (event.target as Element).closest('button')) return
    event.preventDefault()
    grabOffset.current = event.clientY - event.currentTarget.getBoundingClientRect().top
    setIsResizing(true)
  }

  useEffect(() => {
    if (!isResizing) return
    let latest = height
    let lastY = 0
    // Follow-ups left for the current pointer position (see below); a new mouse move refills them
    let followUps = 0
    const apply = perFrame((clientY: number) => {
      const root = rootRef.current
      if (!root) return
      const bottom = root.getBoundingClientRect().bottom
      const containerHeight = root.parentElement?.clientHeight ?? window.innerHeight
      const wanted = bottom - (clientY - grabOffset.current)
      latest = clampQueueHeight(wanted, containerHeight)
      setHeight(latest)
      if (wanted > maxQueueHeight(containerHeight)) {
        // Dragged past what fits: ask the host to make the container tall enough (an absolute height,
        // not a step: steps sent every frame before the layout caught up added up and overshot).
        onNeedRoomRef.current?.(Math.ceil(wanted + LISTS_MIN_HEIGHT))
        // The container grows on the next render with no mouse move to tell us: look again then, so
        // the queue reaches the pointer. Limited, because the host may refuse (panel at its maximum).
        if (followUps > 0) {
          followUps--
          apply(clientY)
        }
      }
    })
    const onMove = (event: MouseEvent) => {
      lastY = event.clientY
      followUps = 3
      apply(lastY)
    }
    let settle = 0
    const onUp = () => {
      document.removeEventListener('mousemove', onMove)
      // A few frames for pending follow-ups (the panel may still be growing), then keep the result
      settle = window.setTimeout(() => {
        apply.cancel()
        setIsResizing(false)
        try {
          localStorage.setItem(QUEUE_HEIGHT_STORAGE_KEY, String(latest))
        } catch {
          // Not remembered this time
        }
      }, 90)
    }
    document.addEventListener('mousemove', onMove)
    document.addEventListener('mouseup', onUp)
    return () => {
      window.clearTimeout(settle)
      apply.cancel()
      document.removeEventListener('mousemove', onMove)
      document.removeEventListener('mouseup', onUp)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isResizing])

  const hasCompleted = transfers.some(t => t.status === 'completed')

  return (
    <div ref={rootRef} className={`transfer-queue ${isResizing ? 'is-resizing' : ''}`} style={{ height }}>
      {/* The header is the resize handle: drag it up or down (its buttons are not part of the handle) */}
      <div className="transfer-header" onMouseDown={startResize} title="끌어서 전송 큐 높이 조절">
        <span className="transfer-header-grip" aria-hidden="true"><RxDragHandleDots2 size={16} /></span>
        <span>전송 큐 ({transfers.filter(t => t.status === 'active' || t.status === 'queued').length})</span>
        <div className="transfer-header-actions">
          {hasCompleted && (
            <button
              className="transfer-clear-btn"
              onClick={handleClearCompleted}
              title="완료된 항목 삭제"
              aria-label="완료된 항목 삭제"
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
              {/* Which way the file goes, and from where to where (the full paths are in the hint) */}
              <span
                className={`transfer-direction is-${transfer.type}`}
                title={transfer.type === 'upload'
                  ? `업로드
${transfer.localPath}
→ ${transfer.remotePath}`
                  : `다운로드
${transfer.remotePath}
→ ${transfer.localPath}`}
              >
                {transfer.type === 'upload' ? <RiUploadLine size={13} /> : <RiDownloadLine size={13} />}
                {transfer.type === 'upload' ? '업로드' : '다운로드'}
              </span>
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
              {transfer.status === 'error' && (
                <>
                  <button
                    type="button"
                    className="transfer-action-btn"
                    onClick={() => void handleRetry(transfer)}
                    title="다시 시도"
                    aria-label={`${transfer.fileName} 다시 시도`}
                    disabled={retryingIds.has(transfer.id)}
                  >
                    <RiRestartLine size={16} />
                  </button>
                  <button
                    type="button"
                    className="transfer-action-btn cancel"
                    onClick={() => void handleCancel(transfer.id, true)}
                    title="실패 항목 삭제"
                    aria-label={`${transfer.fileName} 실패 항목 삭제`}
                    disabled={retryingIds.has(transfer.id)}
                  >
                    <RiCloseFill size={16} />
                  </button>
                </>
              )}
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
