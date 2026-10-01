import { useEffect, useRef, useState } from 'react'
import * as Dialog from '@radix-ui/react-dialog'
import type { McpApprovalRequest } from '../../types'
import { RISK_LABELS, revealHiddenChars, secondsLeft } from '../../lib/mcpLabels'
import { toast } from '../../stores/toastStore'
import './Mcp.css'

const TICK_MS = 250

/** "May Claude run this?" dialog for commands that the MCP server holds for approval */
export function McpApprovalDialog() {
  const [request, setRequest] = useState<McpApprovalRequest | null>(null)
  const [now, setNow] = useState(() => Date.now())
  const denyRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    const api = window.electronAPI
    if (typeof api?.onMcpApprovalRequest !== 'function') return
    const offRequest = api.onMcpApprovalRequest((next) => {
      setNow(Date.now())
      setRequest(next)
    })
    const offDismiss = api.onMcpApprovalDismiss?.(({ id }) => {
      setRequest(current => (current?.id === id ? null : current))
    })
    return () => {
      offRequest()
      offDismiss?.()
    }
  }, [])

  useEffect(() => {
    if (!request) return
    const timer = setInterval(() => setNow(Date.now()), TICK_MS)
    return () => clearInterval(timer)
  }, [request])

  if (!request) return null

  const notifyAlreadyHandled = () => toast.info('MCP 요청', '이미 처리된 요청입니다.')

  const respond = async (approved: boolean) => {
    const { id } = request
    setRequest(null)
    try {
      const result = await window.electronAPI.mcpRespondApproval?.(id, approved)
      if (result && result.success === false) notifyAlreadyHandled()
    } catch {
      notifyAlreadyHandled()
    }
  }
  const remaining = secondsLeft(request.expiresAt, now)
  const command = revealHiddenChars(request.command)
  const cwd = request.cwd === null ? null : revealHiddenChars(request.cwd)
  const hasHidden = command.hasHidden || cwd?.hasHidden === true

  return (
    <Dialog.Root open onOpenChange={(open) => { if (!open) void respond(false) }}>
      <Dialog.Portal>
        <Dialog.Overlay className="modal-overlay mcp-approval-overlay" />
        <Dialog.Content
          key={request.id}
          className="modal-content mcp-approval"
          aria-describedby="mcp-approval-command"
          onOpenAutoFocus={(event) => {
            event.preventDefault()
            denyRef.current?.focus()
          }}
        >
          <div className="mcp-approval-header">
            <Dialog.Title className="modal-title">MCP 명령 실행 요청</Dialog.Title>
            <span className="mcp-approval-timer">남은 시간 {remaining}초</span>
          </div>
          <dl className="mcp-approval-fields">
            <dt>세션</dt>
            <dd>
              {request.sessionName}
              {request.folder && <span className="mcp-approval-folder"> ({request.folder})</span>}
            </dd>
            <dt>위치</dt>
            <dd><code>{cwd?.text ?? '알 수 없음'}</code></dd>
            <dt>명령</dt>
            <dd><pre id="mcp-approval-command" className="mcp-approval-command">{command.text}</pre></dd>
            <dt>위험도</dt>
            <dd>
              <span className={`mcp-risk mcp-risk-${request.level}`}>{RISK_LABELS[request.level] ?? request.level}</span>
              {request.reasons.length > 0 && (
                <ul className="mcp-approval-reasons">
                  {request.reasons.map((reason, index) => <li key={`${index}-${reason}`}>{reason}</li>)}
                </ul>
              )}
            </dd>
          </dl>
          {hasHidden && (
            <p className="mcp-approval-warning" role="alert">보이지 않는 문자가 포함되어 있습니다. 명령을 꼼꼼히 확인하세요.</p>
          )}
          <p className="mcp-approval-hint">Claude Code 가 요청한 명령입니다. 내용을 확인한 뒤 허용하세요. 응답하지 않으면 시간이 지나 자동으로 거부됩니다.</p>
          <div className="mcp-approval-actions">
            <button ref={denyRef} type="button" className="btn-secondary" onClick={() => void respond(false)}>거부</button>
            <button type="button" className="mcp-approve-btn" onClick={() => void respond(true)}>허용</button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}
