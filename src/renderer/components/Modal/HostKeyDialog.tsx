import { useEffect, useRef, useState } from 'react'
import * as Dialog from '@radix-ui/react-dialog'
import { RiErrorWarningLine, RiShieldKeyholeLine } from 'react-icons/ri'
import type { HostKeyPrompt } from '../../types'
import './ConfirmDialog.css'
import './HostKeyDialog.css'

/**
 * "신뢰" stays off for a moment after a question appears. Questions queue up, and the next one opens where
 * the last one closed: without this a double click would trust a key nobody has read.
 */
const TRUST_DELAY_MS = 800

interface HostKeyContentProps {
  request: HostKeyPrompt
  onRespond: (decision: 'trust' | 'reject') => void
}

/** One question. Mounted anew for every request (keyed by id), so the delay starts again. */
function HostKeyContent({ request, onRespond }: HostKeyContentProps) {
  const rejectRef = useRef<HTMLButtonElement>(null)
  const [isArmed, setIsArmed] = useState(false)
  const isChanged = request.status === 'changed'
  const where = request.port === 22 ? request.host : `${request.host}:${request.port}`

  useEffect(() => {
    const timer = setTimeout(() => setIsArmed(true), TRUST_DELAY_MS)
    return () => clearTimeout(timer)
  }, [])

  return (
    <Dialog.Content
      className="modal-content confirm-dialog host-key-dialog"
      onOpenAutoFocus={(e) => {
        e.preventDefault()
        rejectRef.current?.focus()
      }}
      onEscapeKeyDown={() => onRespond('reject')}
      onPointerDownOutside={(e) => e.preventDefault()}
    >
      <Dialog.Title className="modal-title">
        {isChanged
          ? <RiErrorWarningLine size={20} className="confirm-dialog-icon is-danger" />
          : <RiShieldKeyholeLine size={20} className="confirm-dialog-icon" />}
        {isChanged ? '호스트 키가 바뀌었습니다' : '처음 접속하는 서버입니다'}
      </Dialog.Title>
      <Dialog.Description className="confirm-dialog-message">
        {isChanged
          ? `${where} 서버가 보낸 호스트 키가 저장된 키와 다릅니다. 서버를 다시 설치했거나 키를 바꾼 것이 아니라면, 누군가 중간에서 접속을 가로채고 있을 수 있습니다. 확실하지 않으면 접속하지 마세요.`
          : `${where} 서버의 호스트 키를 처음 받았습니다. 지문이 서버 관리자가 알려 준 값과 같은지 확인한 뒤 신뢰하세요.`}
      </Dialog.Description>

      <dl className="host-key-fields">
        {isChanged && request.previous && (
          <>
            <dt>저장된 키</dt>
            <dd>
              <span className="host-key-type">{request.previous.keyType}</span>
              <code className="host-key-fingerprint">{request.previous.fingerprint}</code>
            </dd>
          </>
        )}
        <dt>{isChanged ? '새 키' : '키'}</dt>
        <dd>
          <span className="host-key-type">{request.keyType}</span>
          <code className={`host-key-fingerprint${isChanged ? ' is-new' : ''}`}>{request.fingerprint}</code>
        </dd>
      </dl>

      <div className="modal-actions">
        <button ref={rejectRef} type="button" className="btn-secondary modal-btn" onClick={() => onRespond('reject')}>
          접속 안 함
        </button>
        <button
          type="button"
          className={`modal-btn ${isChanged ? 'btn-danger' : 'btn-primary'}`}
          disabled={!isArmed}
          onClick={() => onRespond('trust')}
        >
          {isChanged ? '새 키로 바꾸고 접속' : '신뢰하고 접속'}
        </button>
      </div>
    </Dialog.Content>
  )
}

/**
 * Asks whether to trust an SSH host key (main: src/hostKeys/hostKeyPrompt.js). Mount once, in the main window.
 * The answer carries only the request id and the decision; main saves the key it kept itself.
 */
export function HostKeyDialog() {
  const [queue, setQueue] = useState<HostKeyPrompt[]>([])

  useEffect(() => {
    const api = window.electronAPI
    if (typeof api.onHostKeyPrompt !== 'function' || typeof api.onHostKeyDismiss !== 'function') return
    const offPrompt = api.onHostKeyPrompt((request) => {
      setQueue(current => (current.some(item => item.id === request.id) ? current : [...current, request]))
    })
    const offDismiss = api.onHostKeyDismiss(({ id }) => {
      setQueue(current => current.filter(item => item.id !== id))
    })
    return () => {
      offPrompt()
      offDismiss()
    }
  }, [])

  const request = queue[0] ?? null

  const respond = (decision: 'trust' | 'reject') => {
    if (!request) return
    window.electronAPI.respondHostKey?.(request.id, decision)
    setQueue(current => current.filter(item => item.id !== request.id))
  }

  return (
    <Dialog.Root open={request !== null}>
      {request && (
        <Dialog.Portal>
          <Dialog.Overlay className="modal-overlay host-key-dialog-overlay" />
          <HostKeyContent key={request.id} request={request} onRespond={respond} />
        </Dialog.Portal>
      )}
    </Dialog.Root>
  )
}
