const fs = require('node:fs')
const path = require('node:path')
const { isUuid } = require('../agentHistory/common.js')

const NOT_FOUND = '대화 기록을 찾지 못했습니다.'
const UNUSABLE = 'Claude 계정의 설정 폴더를 사용할 수 없습니다.'
const MAX_PROJECT_FOLDERS = 5000

const statOf = target => fs.lstatSync(target, { throwIfNoEntry: false })
const isRealDirectory = stat => Boolean(stat?.isDirectory() && !stat.isSymbolicLink())

function requireRealDirectory(folder) {
  if (!isRealDirectory(statOf(folder))) throw new Error(UNUSABLE)
  return folder
}

/** A child folder that is ours to write in: missing (made now) or a real folder, never a link */
function ensureRealDirectory(folder) {
  const stat = statOf(folder)
  if (!stat) fs.mkdirSync(folder, { mode: 0o700 })
  else if (!isRealDirectory(stat)) throw new Error(UNUSABLE)
  return folder
}

function insideRoot(root, target) {
  const relative = path.relative(fs.realpathSync.native(root), fs.realpathSync.native(target))
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative)
}

/** Claude names the project folder after the cwd with every other character replaced by '-' */
const encodedCwd = cwd => (typeof cwd === 'string' ? cwd.replace(/[^a-zA-Z0-9]/g, '-') : '')

function transcriptIn(projects, folder, sessionId) {
  const directory = path.join(projects, folder)
  const file = path.join(directory, sessionId + '.jsonl')
  if (!isRealDirectory(statOf(directory)) || !statOf(file)?.isFile()) return null
  return { folder, directory, file }
}

/** The project folder of the session: the cwd's own folder first, else the only folder that has it */
function findTranscript(projects, sessionId, cwd) {
  const own = encodedCwd(cwd) && transcriptIn(projects, encodedCwd(cwd), sessionId)
  if (own) return own
  const folders = fs.readdirSync(projects, { withFileTypes: true }).filter(entry => entry.isDirectory()).slice(0, MAX_PROJECT_FOLDERS)
  const found = folders.map(entry => transcriptIn(projects, entry.name, sessionId)).filter(Boolean)
  if (found.length !== 1) throw new Error(NOT_FOUND)
  return found[0]
}

function copyDirectoryWithoutLinks(from, to) {
  fs.cpSync(from, to, { recursive: true, errorOnExist: true, force: false, filter: item => !statOf(item)?.isSymbolicLink() })
}

/**
 * Copies a Claude conversation to another account's config folder (CLAUDE_CONFIG_DIR) so that
 * `claude --resume` finds it there. The transcript and its session folder (tool results, subagents)
 * go to the same project folder name. An earlier copy in the target is kept under another name.
 */
function copyClaudeTranscript({ sourceRoot, targetRoot, sessionId, cwd, now = Date.now() }) {
  if (!isUuid(sessionId)) throw new Error(NOT_FOUND)
  if (typeof sourceRoot !== 'string' || typeof targetRoot !== 'string' || !path.isAbsolute(sourceRoot) || !path.isAbsolute(targetRoot)) {
    throw new Error(UNUSABLE)
  }
  requireRealDirectory(sourceRoot)
  requireRealDirectory(targetRoot)
  if (fs.realpathSync.native(sourceRoot) === fs.realpathSync.native(targetRoot)) throw new Error('이미 이 계정으로 실행 중입니다.')
  const sourceProjects = path.join(sourceRoot, 'projects')
  if (!isRealDirectory(statOf(sourceProjects))) throw new Error(NOT_FOUND)
  const source = findTranscript(sourceProjects, sessionId, cwd)
  if (!insideRoot(sourceRoot, source.file)) throw new Error(NOT_FOUND)
  const sessionFolder = path.join(source.directory, sessionId)
  const sessionStat = statOf(sessionFolder)
  const withFolder = isRealDirectory(sessionStat)

  const directory = ensureRealDirectory(path.join(ensureRealDirectory(path.join(targetRoot, 'projects')), source.folder))
  if (!insideRoot(targetRoot, directory)) throw new Error(UNUSABLE)
  const file = path.join(directory, sessionId + '.jsonl')
  const folder = path.join(directory, sessionId)
  const pendingFile = file + '.ezshell-copy'
  const pendingFolder = folder + '.ezshell-copy'
  fs.rmSync(pendingFile, { force: true })
  fs.rmSync(pendingFolder, { recursive: true, force: true })
  try {
    if (withFolder) copyDirectoryWithoutLinks(sessionFolder, pendingFolder)
    fs.copyFileSync(source.file, pendingFile, fs.constants.COPYFILE_EXCL)
    if (statOf(file)) fs.renameSync(file, `${file}.before-${now}.bak`)
    if (statOf(folder)) fs.renameSync(folder, `${folder}.before-${now}`)
    if (withFolder) fs.renameSync(pendingFolder, folder)
    fs.renameSync(pendingFile, file)
  } catch (error) {
    fs.rmSync(pendingFile, { force: true })
    fs.rmSync(pendingFolder, { recursive: true, force: true })
    throw error
  }
  return { folder: source.folder }
}

module.exports = { copyClaudeTranscript }
