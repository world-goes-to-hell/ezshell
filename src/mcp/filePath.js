// Turns the path an MCP file tool was given into one absolute, normalised remote path.
// Purely textual: whether the path exists, or is a link, is found out later over SFTP.
const path = require('path').posix

const MAX_PATH_LENGTH = 1024
const EMPTY_MESSAGE = '경로가 비어 있습니다.'
const NUL_MESSAGE = '경로에 사용할 수 없는 문자가 있습니다.'
const TOO_LONG_MESSAGE = `경로가 너무 깁니다 (${MAX_PATH_LENGTH}자까지).`
const FOLDER_MESSAGE = '폴더가 아니라 파일 경로를 지정하세요.'
const NO_CWD_MESSAGE = '작업 디렉터리를 알 수 없어 상대 경로를 쓸 수 없습니다. 절대 경로를 지정하세요.'
const NO_HOME_MESSAGE = '홈 디렉터리를 알 수 없습니다. 절대 경로를 지정하세요.'

const refuse = (error) => ({ ok: false, error })
/** A last segment that names a folder, not a file */
const FOLDER_ENDINGS = /(^|\/)(\.|\.\.)?$/

/**
 * `cwd` and `home` are absolute remote paths, or null when not known.
 * "~" and "~/x" mean the home folder; "~name" is an ordinary file name.
 */
function resolveRemotePath(input, { cwd, home }) {
  if (typeof input !== 'string' || input.trim() === '') return refuse(EMPTY_MESSAGE)
  if (input.includes('\0')) return refuse(NUL_MESSAGE)
  if (input.length > MAX_PATH_LENGTH) return refuse(TOO_LONG_MESSAGE)
  if (FOLDER_ENDINGS.test(input) || input === '~') return refuse(FOLDER_MESSAGE)

  let absolute
  if (input.startsWith('/')) {
    absolute = input
  } else if (input.startsWith('~/')) {
    if (!home) return refuse(NO_HOME_MESSAGE)
    absolute = `${home}/${input.slice(2)}`
  } else {
    if (!cwd) return refuse(NO_CWD_MESSAGE)
    absolute = `${cwd}/${input}`
  }

  const normalized = path.normalize(absolute)
  if (normalized === '/' || normalized.endsWith('/')) return refuse(FOLDER_MESSAGE)
  if (normalized.length > MAX_PATH_LENGTH) return refuse(TOO_LONG_MESSAGE)
  return { ok: true, path: normalized }
}

module.exports = { resolveRemotePath, MAX_PATH_LENGTH }
