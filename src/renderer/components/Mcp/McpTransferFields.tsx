import type { McpApprovalRequest } from '../../types'
import { TRANSFER_DIRECTION_LABELS, formatBytes, revealPath } from '../../lib/mcpLabels'

interface PathFieldProps {
  path?: string
  requested?: string
  /** Set on the receiving side: whether a file is created or replaced there */
  receiving?: string
}

function PathField({ path, requested, receiving }: PathFieldProps) {
  const shown = revealPath(path ?? '')
  const asked = requested && requested !== path ? revealPath(requested) : null
  return (
    <dd>
      <code className="mcp-transfer-path">{shown.text}</code>
      {receiving && <span className="mcp-approval-folder"> · {receiving}</span>}
      {asked && <div className="mcp-approval-requested">요청 경로: <code className="mcp-transfer-path">{asked.text}</code></div>}
    </dd>
  )
}

/** The rows of the approval dialog for upload_file / download_file: direction, both ends, size */
export function McpTransferFields({ request }: { request: McpApprovalRequest }) {
  const isUpload = request.direction === 'upload'
  const receiving = request.isNew ? '새 파일' : '기존 파일 덮어쓰기'
  const size = request.size ?? 0
  return (
    <>
      <dt>방향</dt>
      <dd className="mcp-transfer-direction">{TRANSFER_DIRECTION_LABELS[isUpload ? 'upload' : 'download']}</dd>
      <dt>PC 파일</dt>
      <PathField path={request.localPath} requested={request.requestedLocalPath} receiving={isUpload ? undefined : receiving} />
      <dt>서버 파일</dt>
      <PathField path={request.remotePath} requested={request.requestedRemotePath} receiving={isUpload ? receiving : undefined} />
      <dt>크기</dt>
      <dd>{formatBytes(size)} <span className="mcp-approval-folder">({size.toLocaleString('ko-KR')}바이트)</span></dd>
    </>
  )
}
