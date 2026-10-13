// What the user is told before a file moves between this PC and a server. A transfer is always
// "danger": the user sees both ends and decides, whatever the alert level is set to.
const { sensitiveFindings } = require('./commandPolicy.js')
const { DANGER } = require('./commandRules.js')
const { isSystemPath, isExecutionPath } = require('./filePolicy.js')

const DEFAULT_NEW_FILE_MODE = 0o644
const SECRET_NEW_FILE_MODE = 0o600
const SYSTEM_PATH_MESSAGE = '시스템 경로(/proc, /sys, /dev)의 파일은 전송할 수 없습니다.'
// Beyond the remote list in commandPolicy.js: places a Windows or developer PC keeps secrets in
const LOCAL_SECRET_PATHS = [
  /(^|\/)\.(aws|azure|gnupg|docker)(\/|$)/i,
  /(^|\/)\.(npmrc|netrc|git-credentials|claude\.json|mcp\.json)$/i,
  /\.(ppk|kdbx|ovpn)$/i,
  /(^|\/)(sessions|master|mcp)\.json$/i,
  /password|token/i
]
// Files Windows runs, or opens with something that runs them, on a double click
const PROGRAM_EXTENSIONS = /\.(exe|dll|com|scr|msi|msp|bat|cmd|ps1|psm1|psd1|vbs|vbe|js|jse|wsf|wsh|hta|lnk|reg|jar|cpl|sys|pif|url|inf|scf|sh|py|rdp|chm|xll|application)$/i
// Places development tools run things from, or read as settings, whatever the file is called
const TOOL_PATHS = [
  /(^|\/)\.git\/(hooks\/|config$)/i,
  /(^|\/)\.(vscode|idea|husky|github)\//i,
  /(^|\/)(package\.json|makefile|\.npmrc|\.gitconfig|\.bashrc|\.profile)$/i
]
const isToolPath = (localPath) => TOOL_PATHS.some(pattern => pattern.test(localPath.replace(/\\/g, '/')))

/** A message when the remote path must not be transferred at all, otherwise null. */
function refuseRemotePath(path) {
  return isSystemPath(path) ? SYSTEM_PATH_MESSAGE : null
}

const unique = (values) => [...new Set(values)]
const looksSecretLocally = (localPath) => {
  const slashed = localPath.replace(/\\/g, '/')
  return sensitiveFindings([slashed]).length > 0 || LOCAL_SECRET_PATHS.some(pattern => pattern.test(slashed))
}

/**
 * `local` is { path, requestedPath } on this PC, `remote` { path, requestedPath, isSymlink } on the
 * server (`path` is the real one behind links). `isNew` tells whether the receiving side has no such
 * file yet; `ownerDiffers` whether a replaced remote file belongs to another account (null: unknown).
 * `newFileMode` is the mode a new remote file gets.
 */
function classifyTransfer({ direction, local, remote, isNew, ownerDiffers = false }) {
  const isUpload = direction === 'upload'
  const reasons = [isUpload ? 'PC 의 파일을 서버로 보냄' : '서버의 파일을 PC 로 가져옴']
  reasons.push(isNew ? '받는 쪽에 새 파일 만들기' : '받는 쪽의 기존 파일 덮어쓰기')

  if (remote.requestedPath !== remote.path) {
    const verb = isUpload ? '씀' : '읽음'
    reasons.push(remote.isSymlink
      ? `심볼릭 링크를 따라 다른 파일을 ${verb}: ${remote.requestedPath} → ${remote.path}`
      : `서버의 실제 경로가 요청한 경로와 다름: ${remote.requestedPath} → ${remote.path}`)
  }
  if (local.requestedPath !== local.path) reasons.push(`PC 의 실제 경로가 요청한 경로와 다름: ${local.requestedPath} → ${local.path}`)

  const remotePaths = unique([remote.path, remote.requestedPath])
  const remoteSecrets = sensitiveFindings(remotePaths)
  reasons.push(...remoteSecrets.map(finding => (isUpload ? finding.reason : `${finding.reason} (비밀 파일을 PC 로 가져옴)`)))
  const localPaths = unique([local.path, local.requestedPath])
  if (isUpload) {
    reasons.push(...localPaths.filter(looksSecretLocally).map(candidate => `비밀 정보일 수 있는 PC 파일을 서버로 보냄: ${candidate}`))
    reasons.push(...remotePaths.filter(isExecutionPath).map(candidate => `로그인·예약 실행·권한에 영향을 주는 파일: ${candidate}`))
    if (!isNew && ownerDiffers !== false) {
      reasons.push(ownerDiffers === null
        ? '덮어쓰면 파일의 소유자가 접속 계정으로 바뀔 수 있음 (권한은 유지)'
        : '덮어쓰면 파일의 소유자가 접속 계정으로 바뀜 (권한은 유지)')
    }
  } else {
    reasons.push(...localPaths.filter(candidate => PROGRAM_EXTENSIONS.test(candidate)).map(candidate => `실행될 수 있는 종류의 파일을 PC 에 씀: ${candidate}`))
    reasons.push(...localPaths.filter(isToolPath).map(candidate => `개발 도구가 실행하거나 설정으로 읽는 위치에 씀: ${candidate}`))
  }

  const isSecretNewFile = isUpload && isNew && remoteSecrets.length > 0
  if (isSecretNewFile) reasons.push('비밀 경로이므로 소유자만 읽을 수 있게 만듦 (권한 600)')
  return { level: DANGER, reasons, newFileMode: isSecretNewFile ? SECRET_NEW_FILE_MODE : DEFAULT_NEW_FILE_MODE }
}

module.exports = { classifyTransfer, refuseRemotePath }
