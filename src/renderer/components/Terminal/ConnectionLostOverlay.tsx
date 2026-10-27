import { useEffect, useRef, useState } from 'react'
import { RiCloseCircleLine, RiLinkUnlinkM, RiLoader4Line, RiRefreshLine } from 'react-icons/ri'
import { describeConnectionLost } from '../../lib/connectionLost'
import './ConnectionLostOverlay.css'

const FAILED_TEXT = '다시 연결하지 못했습니다.'

interface ConnectionLostOverlayProps {
  sessionId: string
  reconnect?: { attempt: number; maxAttempts: number } | null
  note?: string | null
  /** 종료: closes the tab (the same as its ×) or the popped-out window */
  onClose: () => void
  /** 재연결 worked; the caller marks the terminal connected */
  onReconnected: () => void
  /** 재연결 failed, with the reason to show */
  onReconnectFailed: (note: string) => void
}

/**
 * Over a tab whose connection dropped: says so, and offers 재연결 (the same way the tab first connected)
 * or 종료. It takes no keyboard focus, so keys typed for something else do not press a button.
 */
export function ConnectionLostOverlay({ sessionId, reconnect, note, onClose, onReconnected, onReconnectFailed }: ConnectionLostOverlayProps) {
  const [isReconnecting, setIsReconnecting] = useState(false)
  const isMounted = useRef(true)
  useEffect(() => () => { isMounted.current = false }, [])
  const view = describeConnectionLost({ reconnect, note, isReconnecting })
  const canReconnect = typeof window.electronAPI?.sshReconnectNow === 'function'

  const reconnectNow = async () => {
    setIsReconnecting(true)
    try {
      const result = await window.electronAPI.sshReconnectNow?.(sessionId)
      if (result?.success) onReconnected()
      else onReconnectFailed(result?.error || FAILED_TEXT)
    } catch {
      onReconnectFailed(FAILED_TEXT)
    } finally {
      if (isMounted.current) setIsReconnecting(false)
    }
  }

  return (
    <div className="connection-lost" role="alertdialog" aria-labelledby={`connection-lost-${sessionId}`} onClick={(event) => event.stopPropagation()}>
      <div className="connection-lost-card">
        <span className="connection-lost-icon" aria-hidden="true">
          <RiLinkUnlinkM size={26} />
        </span>
        <h3 className="connection-lost-title" id={`connection-lost-${sessionId}`}>{view.title}</h3>
        <p className="connection-lost-detail" aria-live="polite">
          {view.isWorking && <RiLoader4Line className="spinning" size={14} aria-hidden="true" />}
          <span>{view.detail}</span>
        </p>
        <div className="connection-lost-actions">
          {canReconnect && (
            <button type="button" className="btn-primary connection-lost-btn" onClick={() => void reconnectNow()} disabled={!view.canAct}>
              <RiRefreshLine size={15} aria-hidden="true" />
              <span>{reconnect ? '지금 재연결' : '재연결'}</span>
            </button>
          )}
          <button type="button" className="btn-secondary connection-lost-btn" onClick={onClose} disabled={!view.canAct}>
            <RiCloseCircleLine size={15} aria-hidden="true" />
            <span>종료</span>
          </button>
        </div>
      </div>
    </div>
  )
}
