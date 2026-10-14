// Title of the OS notification shown when an approval dialog waits while the app window is in the
// background. Only the kind of request goes in: toasts stay in the Action Center, so the command,
// the paths and the file content never do.

const TITLES = {
  command: 'MCP 명령 확인 요청',
  background: 'MCP 백그라운드 실행 확인 요청',
  file: 'MCP 파일 쓰기 확인 요청',
  upload: 'MCP 파일 올리기 확인 요청',
  download: 'MCP 파일 내려받기 확인 요청',
  transfer: 'MCP 파일 전송 확인 요청'
}

/** @param {{ kind?: string, direction?: string, background?: unknown }} request */
function approvalNoticeTitle(request) {
  if (!request) return TITLES.command
  if (request.kind === 'file') return TITLES.file
  if (request.kind === 'transfer') {
    if (request.direction === 'upload') return TITLES.upload
    if (request.direction === 'download') return TITLES.download
    return TITLES.transfer
  }
  return request.background ? TITLES.background : TITLES.command
}

module.exports = { approvalNoticeTitle }
