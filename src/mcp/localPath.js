// Decides whether a path on this PC may be used by the MCP transfer tools.
// Only files inside the folders the user registered (Settings > MCP) qualify, judged by the real
// path behind links and junctions. A path outside them is refused before the file system is touched,
// with the same answer whether or not it exists.
const nodePath = require('path')

const MAX_PATH_LENGTH = 1024
const MESSAGES = {
  empty: 'PC 경로가 비어 있습니다.',
  tooLong: `PC 경로가 너무 깁니다 (${MAX_PATH_LENGTH}자까지).`,
  badChars: 'PC 경로에 사용할 수 없는 문자가 있습니다.',
  notAbsolute: 'PC 경로는 드라이브 문자로 시작하는 절대 경로여야 합니다 (예: C:\\work\\app.jar). 네트워크 경로와 장치 경로는 쓸 수 없습니다.',
  notAbsolutePosix: 'PC 경로는 절대 경로여야 합니다.',
  folder: '폴더가 아니라 파일 경로를 지정하세요.',
  badName: 'PC 경로에 사용할 수 없는 이름이 있습니다 (예약된 이름, 점이나 공백으로 끝나는 이름, 콜론).',
  noRoots: '파일 전송 허용 폴더가 없습니다. 앱의 설정 > MCP 에서 "파일 전송 허용 폴더"를 추가하세요.',
  outside: '파일 전송 허용 폴더 밖의 경로입니다. 앱의 설정 > MCP 에 등록된 폴더 안의 파일만 전송할 수 있습니다.',
  appData: '앱의 데이터 폴더에 있는 파일은 전송할 수 없습니다.',
  // One answer for everything found out on disk, so a link inside a registered folder cannot be
  // used to ask whether the place it points at exists
  unreachable: '파일 전송 허용 폴더 안에서 쓸 수 없는 경로입니다. 상위 폴더가 없거나, 경로의 링크가 허용 폴더 밖을 가리키거나, 등록한 폴더가 바뀌었습니다.'
}

const refuse = (error) => ({ ok: false, error })
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u001f]/
const DRIVE_ABSOLUTE = /^[A-Za-z]:[\\/]/
const RESERVED_NAME = /^(con|prn|aux|nul|conin\$|conout\$|com[1-9\u00b9\u00b2\u00b3]|lpt[1-9\u00b9\u00b2\u00b3])(\.|$)/i

/** `inner` is `outer` itself or lies below it */
function isInside(pathApi, outer, inner) {
  const relative = pathApi.relative(outer, inner)
  // A name may itself begin with two dots ("..notes"); only ".." as a whole step leads out
  const leadsOut = relative === '..' || relative.startsWith(`..${pathApi.sep}`)
  return relative === '' || (!leadsOut && !pathApi.isAbsolute(relative))
}

/** The path made absolute and normalised, judged by its text alone. */
function checkForm(input, pathApi) {
  if (typeof input !== 'string' || input.trim() === '') return refuse(MESSAGES.empty)
  if (input.length > MAX_PATH_LENGTH) return refuse(MESSAGES.tooLong)
  if (CONTROL_CHARS.test(input)) return refuse(MESSAGES.badChars)
  const isWindows = pathApi.sep === '\\'
  if (isWindows) {
    // Rules out UNC (\\server\share), device paths (\\?\, \\.\) and drive-relative paths (C:file)
    if (!DRIVE_ABSOLUTE.test(input)) return refuse(MESSAGES.notAbsolute)
  } else if (!input.startsWith('/')) {
    return refuse(MESSAGES.notAbsolutePosix)
  }
  if (/[\\/]$/.test(input) && isWindows) return refuse(MESSAGES.folder)
  if (input.endsWith('/')) return refuse(MESSAGES.folder)
  const normalized = pathApi.normalize(input)
  if (normalized.endsWith(pathApi.sep)) return refuse(MESSAGES.folder)
  if (isWindows) {
    const names = normalized.slice(3).split('\\')
    // A colon past the drive letter names an alternate data stream
    const isBad = (name) => name.includes(':') || RESERVED_NAME.test(name) || /[. ]$/.test(name)
    if (names.some(isBad)) return refuse(MESSAGES.badName)
  }
  return { ok: true, path: normalized }
}

/**
 * `roots` are the registered folders, `userDataDir` the app's own data folder (never transferable).
 * `realpath(path)` resolves links and junctions and rejects for a path that does not exist.
 * `lstat(path)` (optional) tells a link whose target is missing from a file that does not exist.
 * Resolves with { ok: true, path, requestedPath } where `path` is the real path (the file itself
 * may not exist yet), or { ok: false, error }.
 */
async function resolveLocalPath(input, { roots, userDataDir, realpath, lstat, pathApi = nodePath }) {
  const formed = checkForm(input, pathApi)
  if (!formed.ok) return formed
  const allowed = Array.isArray(roots) ? roots.filter(root => typeof root === 'string' && root !== '') : []
  if (allowed.length === 0) return refuse(MESSAGES.noRoots)
  // By text first: nothing outside the registered folders is looked at, so nothing about it can be learned
  if (!allowed.some(root => isInside(pathApi, root, formed.path) && pathApi.normalize(root) !== formed.path)) return refuse(MESSAGES.outside)

  let realParent
  try {
    realParent = await realpath(pathApi.dirname(formed.path))
  } catch {
    return refuse(MESSAGES.unreachable)
  }
  const candidate = pathApi.join(realParent, pathApi.basename(formed.path))
  // An existing file may itself be a link; a file that does not exist yet keeps its place in the real parent
  let real = candidate
  try {
    real = await realpath(candidate)
  } catch {
    // Not there, or a link to nowhere. The second must not pass as "a new file here".
    const isThere = typeof lstat === 'function' && await lstat(candidate).then(() => true, () => false)
    if (isThere) return refuse(MESSAGES.unreachable)
  }

  // A folder is registered by its real path. One that now resolves elsewhere was replaced by a
  // junction after the user registered it; what that reaches was never registered.
  const intact = await Promise.all(allowed.map(async (root) => {
    const now = await realpath(root).catch(() => null)
    return now !== null && pathApi.relative(root, now) === '' ? now : null
  }))
  const realRoots = intact.filter(Boolean)
  if (!realRoots.some(root => isInside(pathApi, root, real) && pathApi.relative(root, real) !== '')) return refuse(MESSAGES.unreachable)
  if (typeof userDataDir === 'string' && userDataDir !== '') {
    const realUserData = await realpath(userDataDir).catch(() => userDataDir)
    if (isInside(pathApi, realUserData, real)) return refuse(MESSAGES.appData)
  }
  return { ok: true, path: real, requestedPath: formed.path }
}

module.exports = { resolveLocalPath, isInside, MESSAGES, MAX_PATH_LENGTH }
