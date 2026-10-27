import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import * as Dialog from '@radix-ui/react-dialog'
import type { McpApprovalRequest } from '../../types'
import { RISK_LABELS, revealHiddenChars, revealPath, secondsLeft } from '../../lib/mcpLabels'
import { revealDiff } from '../../lib/mcpDiff'
import { McpDiffView } from './McpDiffView'
import { McpTransferFields } from './McpTransferFields'
import { toast } from '../../stores/toastStore'
import { isApprovalArmed } from '../../lib/approvalArming'
import './Mcp.css'

const TICK_MS = 250
const UNFOCUSED_NOTE = '이 창을 한 번 누르면 잠시 뒤 응답할 수 있습니다.'
const COMMAND_HINT = 'Claude Code 가 요청한 명령입니다. 내용을 확인한 뒤 허용하세요. 응답하지 않으면 시간이 지나 자동으로 거부됩니다.'
const FILE_HINT = 'Claude Code 가 요청한 파일 변경입니다. 허용하면 위 내용 그대로 서버의 파일에 씁니다. 응답하지 않으면 시간이 지나 자동으로 거부됩니다.'
const TRANSFER_HINT = 'Claude Code 가 요청한 파일 전송입니다. 양쪽 경로와 방향을 확인한 뒤 허용하세요. 파일 내용은 여기에 표시되지 않습니다. 응답하지 않으면 시간이 지나 자동으로 거부됩니다.'
const PURPOSE_NOTE = 'Claude Code 가 직접 적은 설명입니다. 실제 명령과 다를 수 있으니 아래 명령을 기준으로 판단하세요.'
const NO_CHANGE_HINT = 'Claude Code 가 보낸 내용이 지금 파일과 같습니다. 허용하면 파일은 그대로 두고, 내용이 같다는 사실만 알려 줍니다.'

interface ApprovalContentProps {
  request: McpApprovalRequest
  now: number
  onRespond: (approved: boolean) => void
}

/** One request. Mounted anew for every request (keyed by id), so its state never carries over. */
function ApprovalContent({ request, now, onRespond }: ApprovalContentProps) {
  const contentRef = useRef<HTMLDivElement>(null)
  const [shownAt] = useState(() => Date.now())
  // The window comes forward by itself without focus; the buttons wait until it has focus for a moment
  const [hasFocus, setHasFocus] = useState(() => document.hasFocus())
  const [focusedAt, setFocusedAt] = useState<number | null>(() => (document.hasFocus() ? Date.now() : null))

  useEffect(() => {
    const onFocus = () => {
      setHasFocus(true)
      setFocusedAt(Date.now())
    }
    const onBlur = () => setHasFocus(false)
    window.addEventListener('focus', onFocus)
    window.addEventListener('blur', onBlur)
    return () => {
      window.removeEventListener('focus', onFocus)
      window.removeEventListener('blur', onBlur)
    }
  }, [])
  // A file change (write_file / edit_file) shows what changes instead of a command
  const isFile = request.kind === 'file'
  // A transfer (upload_file / download_file) shows both ends; there is no content to show
  const isTransfer = request.kind === 'transfer'
  const hasDiff = isFile && (request.hunks?.length ?? 0) > 0
  // The whole change must have been on screen before it can be allowed
  const [hasSeenEnd, setHasSeenEnd] = useState(!hasDiff)
  const markSeenEnd = useCallback(() => setHasSeenEnd(true), [])
  const diff = useMemo(() => revealDiff(request.hunks ?? []), [request.hunks])

  const remaining = secondsLeft(request.expiresAt, now)
  const command = revealHiddenChars(request.command)
  const cwd = request.cwd === null ? null : revealHiddenChars(request.cwd)
  // Claude's own words: shown, but it is the command that counts
  const purpose = request.purpose ? revealHiddenChars(request.purpose) : null
  const filePath = revealPath(request.path ?? '')
  const requestedPath = request.requestedPath && request.requestedPath !== request.path ? revealPath(request.requestedPath) : null
  const transferPaths = [request.localPath, request.requestedLocalPath, request.remotePath, request.requestedRemotePath]
  const hasHiddenInTransfer = isTransfer && transferPaths.some(value => typeof value === 'string' && revealPath(value).hasHidden)
  const hasHiddenInFile = filePath.hasHidden || requestedPath?.hasHidden === true || diff.hasHidden
  const hasHiddenInCommand = command.hasHidden || cwd?.hasHidden === true || purpose?.hasHidden === true
  // Reasons quote paths (a server may answer with any text for one), so they are shown the same way
  const reasons = request.reasons.map(reason => revealHiddenChars(reason))
  const hasHiddenInReasons = reasons.some(reason => reason.hasHidden)
  const hasHidden = hasHiddenInReasons || (isTransfer ? hasHiddenInTransfer : isFile ? hasHiddenInFile : hasHiddenInCommand)
  const isArmed = isApprovalArmed({ shownAt, focusedAt, hasFocus, now })
  const canApprove = isArmed && hasSeenEnd
  const changeKind = request.noChange ? '변경 없음' : request.isNew ? '새 파일' : '기존 파일 수정'
  const title = isTransfer ? 'MCP 파일 전송 요청' : isFile ? 'MCP 파일 쓰기 요청' : 'MCP 명령 실행 요청'
  const fileHint = request.noChange ? NO_CHANGE_HINT : FILE_HINT
  const hint = isTransfer ? TRANSFER_HINT : isFile ? fileHint : COMMAND_HINT
  const checkedThing = isTransfer ? '경로를' : isFile ? '변경 내용을' : '명령을'

  return (
    <Dialog.Content
      ref={contentRef}
      className={`modal-content mcp-approval${isFile ? ' mcp-approval-file' : ''}`}
      aria-describedby={hasDiff ? 'mcp-approval-diff' : isFile || isTransfer ? 'mcp-approval-hint' : 'mcp-approval-command'}
      // Focus the dialog itself, not a button: Enter or Space typed for something else must not answer
      onOpenAutoFocus={(event) => {
        event.preventDefault()
        contentRef.current?.focus()
      }}
      // Only the two buttons answer (or the time limit). A stray click outside or Esc leaves it open.
      onEscapeKeyDown={(event) => event.preventDefault()}
      onPointerDownOutside={(event) => event.preventDefault()}
      onInteractOutside={(event) => event.preventDefault()}
    >
      <div className="mcp-approval-header">
        <Dialog.Title className="modal-title">{title}</Dialog.Title>
        <span className="mcp-approval-timer">남은 시간 {remaining}초</span>
      </div>
      <dl className="mcp-approval-fields">
        <dt>세션</dt>
        <dd>
          {request.sessionName}
          {request.folder && <span className="mcp-approval-folder"> ({request.folder})</span>}
        </dd>
        {isTransfer ? <McpTransferFields request={request} /> : isFile ? (
          <>
            <dt>파일</dt>
            <dd>
              <code>{filePath.text}</code>
              {requestedPath && <div className="mcp-approval-requested">요청 경로: <code>{requestedPath.text}</code></div>}
            </dd>
            <dt>변경</dt>
            <dd>
              {changeKind}
              {!request.noChange && (
                <>
                  <span className="mcp-diff-stat mcp-diff-stat-add"> +{request.added ?? 0}줄</span>
                  <span className="mcp-diff-stat mcp-diff-stat-remove"> -{request.removed ?? 0}줄</span>
                </>
              )}
              {request.isWholeFile && <div className="mcp-approval-requested">바뀐 곳이 많아 파일 전체를 지우고 새로 쓰는 것으로 표시합니다.</div>}
            </dd>
          </>
        ) : (
          <>
            {purpose && (
              <>
                <dt>요청 사유</dt>
                <dd>
                  <p className="mcp-approval-purpose">{purpose.text}</p>
                  <div className="mcp-approval-requested">{PURPOSE_NOTE}</div>
                </dd>
              </>
            )}
            <dt>위치</dt>
            <dd><code>{cwd?.text ?? '알 수 없음'}</code></dd>
            <dt>명령</dt>
            <dd><pre id="mcp-approval-command" className="mcp-approval-command">{command.text}</pre></dd>
            {request.background && (
              <>
                <dt>실행 방식</dt>
                <dd>
                  백그라운드 실행 · 최대 {request.background.limitMinutes}분
                  <div className="mcp-approval-requested">허용하면 끝날 때까지 서버에서 계속 실행됩니다. MCP 활동 패널에서 중지할 수 있고, 앱을 잠그면 함께 중지됩니다.</div>
                </dd>
              </>
            )}
          </>
        )}
        <dt>위험도</dt>
        <dd>
          <span className={`mcp-risk mcp-risk-${request.level}`}>{RISK_LABELS[request.level] ?? request.level}</span>
          {reasons.length > 0 && (
            <ul className="mcp-approval-reasons">
              {reasons.map((reason, index) => <li key={`${index}-${reason.text}`}>{reason.text}</li>)}
            </ul>
          )}
        </dd>
      </dl>
      {hasDiff && <McpDiffView hunks={diff.hunks} id="mcp-approval-diff" onSeenEnd={markSeenEnd} />}
      {hasHidden && (
        <p className="mcp-approval-warning" role="alert">보이지 않는 문자가 포함되어 있습니다. {hasHiddenInReasons ? '위험도의 이유와 ' : ''}{checkedThing} 꼼꼼히 확인하세요.</p>
      )}
      <p className="mcp-approval-hint" id="mcp-approval-hint">{hint}</p>
      {!hasSeenEnd && <p className="mcp-approval-scroll-note">변경 내용을 끝까지 내려 본 뒤에 허용할 수 있습니다.</p>}
      {!hasFocus && <p className="mcp-approval-scroll-note">{UNFOCUSED_NOTE}</p>}
      <div className="mcp-approval-actions">
        <button type="button" className="btn-secondary" disabled={!isArmed} onClick={() => onRespond(false)}>거부</button>
        <button type="button" className="mcp-approve-btn" disabled={!canApprove} onClick={() => onRespond(true)}>허용</button>
      </div>
    </Dialog.Content>
  )
}

/** "May Claude do this?" dialog for the commands, file changes and file transfers the MCP server holds for approval */
export function McpApprovalDialog() {
  const [request, setRequest] = useState<McpApprovalRequest | null>(null)
  const [now, setNow] = useState(() => Date.now())

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

  return (
    // No onOpenChange: the dialog closes only through the buttons, the time limit or a dismiss from main
    <Dialog.Root open>
      <Dialog.Portal>
        <Dialog.Overlay className="modal-overlay mcp-approval-overlay" />
        <ApprovalContent key={request.id} request={request} now={now} onRespond={(approved) => void respond(approved)} />
      </Dialog.Portal>
    </Dialog.Root>
  )
}
