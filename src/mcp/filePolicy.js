// How risky a file write is. Writing is always "danger": the user sees the change and decides,
// whatever the alert level is set to. The reasons tell them what to look at.
const { sensitiveFindings } = require('./commandPolicy.js')
const { DANGER } = require('./commandRules.js')

const DEFAULT_NEW_FILE_MODE = 0o644
const SECRET_NEW_FILE_MODE = 0o600
// Kernel and device interfaces: a "file" here is a switch, not text (writing /proc/sysrq-trigger
// reboots the machine). The command policy blocks the worst of them; the file tools refuse them all.
const SYSTEM_ROOTS = ['/proc', '/sys', '/dev']
const SYSTEM_PATH_MESSAGE = '시스템 경로(/proc, /sys, /dev)에는 쓸 수 없습니다.'
// Files that are run at login, at boot or on a schedule, or that decide who may do what
const EXECUTION_PATHS = [
  /(^|\/)\.(bashrc|bash_profile|bash_login|bash_logout|profile|zshrc|zprofile|zshenv|zlogin|cshrc|login)$/,
  /^\/etc\/profile(\.d\/|$)/,
  /^\/etc\/(bash\.bashrc|environment|passwd|group|crontab|rc\.local|ld\.so\.preload|ld\.so\.conf)$/,
  /^\/etc\/ld\.so\.conf\.d\//,
  /^\/etc\/cron[^/]*\//,
  /^\/var\/spool\/cron(\/|$)/,
  /^\/etc\/systemd\//,
  /^\/(usr\/)?lib\/systemd\//,
  /(^|\/)\.config\/systemd\//,
  /^\/etc\/init\.d\//,
  /^\/etc\/ssh\//,
  /^\/etc\/pam\.d\//,
  /^\/etc\/sudoers\.d\//
]

/** A message when the path must not be written at all, otherwise null. */
function refuseSystemPath(path) {
  return SYSTEM_ROOTS.some(root => path === root || path.startsWith(`${root}/`)) ? SYSTEM_PATH_MESSAGE : null
}

/**
 * `requestedPath` is what the tool was asked for (made absolute); `path` is the real file after
 * resolving links. Both are checked: a harmless name can point at a sensitive file and the reverse.
 * `newFileMode` is the mode a new file gets.
 */
function classifyFileWrite({ requestedPath, path, exists, isSymlink }) {
  const paths = [...new Set([path, requestedPath])]
  const reasons = [exists ? '기존 파일 덮어쓰기' : '새 파일 만들기']
  if (requestedPath !== path) {
    reasons.push(isSymlink
      ? `심볼릭 링크를 따라 다른 파일에 씀: ${requestedPath} → ${path}`
      : `실제 경로가 요청한 경로와 다름: ${requestedPath} → ${path}`)
  }
  const secrets = sensitiveFindings(paths).map(finding => finding.reason)
  reasons.push(...secrets)
  reasons.push(...paths.filter(candidate => EXECUTION_PATHS.some(pattern => pattern.test(candidate))).map(candidate => `로그인·예약 실행·권한에 영향을 주는 파일: ${candidate}`))
  const isSecretNewFile = !exists && secrets.length > 0
  if (isSecretNewFile) reasons.push('비밀 경로이므로 소유자만 읽을 수 있게 만듦 (권한 600)')
  return { level: DANGER, reasons, newFileMode: isSecretNewFile ? SECRET_NEW_FILE_MODE : DEFAULT_NEW_FILE_MODE }
}

module.exports = { classifyFileWrite, refuseSystemPath }
