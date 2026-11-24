// The one Git write of the workspace panel: commit the files the user ticked in the "변경" tab
// (docs/plan/2026-11-24-workspace-git-commit.md). The window names files; main reads the status again
// and commits only paths that are in it now, with their current content (`git commit --only`), so files
// left out stay as they were (staged or not). Paths go through stdin as literal pathspecs.
// Loaded by main.js at runtime (copied to out/main/src), so keep it CommonJS and free of Electron imports.
const { execFile } = require('child_process')
const path = require('path')
const { repoTop, requireRepoPath, statusEntries, SAFE, LIST_MAX } = require('./git.js')

const MESSAGE_MAX = 5000
const ERROR_MAX = 4000
const OUTPUT_MAX_BYTES = 16 * 1024 * 1024
const STATUS_TIMEOUT_MS = 15000
const ADD_TIMEOUT_MS = 30000
// Hooks (pre-commit, commit-msg) run as they do in a terminal; a linter may take a while
const COMMIT_TIMEOUT_MS = 120000
// Line ends are made LF first; tabs and line feeds are the only control characters a message keeps
// eslint-disable-next-line no-control-regex
const MESSAGE_CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/
// Variables that would point Git at another repository or index than the folder's
const FOREIGN_ENV = new Set(['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_COMMON_DIR', 'GIT_OBJECT_DIRECTORY'])

/** Repositories with a commit running, by top folder */
const committing = new Set()
const repoKey = (top) => (process.platform === 'win32' ? path.normalize(top).toLowerCase() : path.normalize(top))

class CommitError extends Error {
  constructor(userMessage) {
    super(userMessage)
    this.userMessage = userMessage
  }
}

function gitEnv() {
  const kept = Object.entries(process.env).filter(([name]) => !FOREIGN_ENV.has(name.toUpperCase()))
  return { ...Object.fromEntries(kept), GIT_TERMINAL_PROMPT: '0' }
}

function run(cwd, args, { input = '', timeout }) {
  return new Promise((resolve, reject) => {
    // core.safecrlf only warns about line ends here ("LF will be replaced by CRLF"); the warning would
    // bury a hook's own output in the panel. The conversion itself is unchanged.
    const child = execFile('git', [...SAFE, '-c', 'core.safecrlf=false', '--literal-pathspecs', ...args], {
      cwd, timeout, windowsHide: true, encoding: 'utf8', maxBuffer: OUTPUT_MAX_BYTES, env: gitEnv()
    }, (error, stdout, stderr) => {
      if (error) {
        error.stdout = String(stdout ?? '')
        error.stderr = String(stderr ?? '')
        reject(error)
      } else {
        resolve(stdout)
      }
    })
    // Git may exit before reading all of stdin (an error): that is reported by the callback
    child.stdin.on('error', () => {})
    child.stdin.end(input)
  })
}

const nulList = (paths) => `${paths.join('\0')}\0`
const FROM_STDIN = ['--pathspec-from-file=-', '--pathspec-file-nul']

/** The message as Git will record it: LF line ends, trimmed, no control characters but tab, 1~5,000 characters */
function requireCommitMessage(message) {
  if (typeof message !== 'string') throw new CommitError('커밋 메시지를 입력해 주세요.')
  const text = message.replace(/\r\n?/g, '\n')
  if (MESSAGE_CONTROL.test(text)) throw new CommitError('커밋 메시지에 쓸 수 없는 글자가 있습니다.')
  const trimmed = text.trim()
  if (!trimmed) throw new CommitError('커밋 메시지를 입력해 주세요.')
  if (trimmed.length > MESSAGE_MAX) throw new CommitError(`커밋 메시지는 ${MESSAGE_MAX.toLocaleString()}자까지 쓸 수 있습니다.`)
  return trimmed
}

function requireFiles(files) {
  if (!Array.isArray(files) || files.length === 0) throw new CommitError('커밋할 파일을 골라 주세요.')
  if (files.length > LIST_MAX) throw new CommitError(`한 번에 ${LIST_MAX.toLocaleString()}개까지 커밋할 수 있습니다.`)
  for (const file of files) {
    try {
      requireRepoPath(file)
    } catch {
      throw new CommitError('커밋할 수 없는 경로가 들어 있습니다.')
    }
  }
  if (new Set(files).size !== files.length) throw new CommitError('같은 파일이 두 번 들어 있습니다.')
  return files
}

// Colour codes and other control characters a hook may print: the panel shows the text as it is
// eslint-disable-next-line no-control-regex
const SHOWN_CONTROL = /\u001b\[[0-9;?]*[ -/]*[@-~]|[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g

/** Git's own words (a hook's output too), cut to what the panel shows */
function commitFailure(error, timedOutMessage) {
  if (error.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') return new CommitError('Git 이나 훅의 출력이 너무 길어 멈췄습니다.')
  if (error.killed || error.code === 'ETIMEDOUT') return new CommitError(timedOutMessage)
  const detail = [error.stderr, error.stdout]
    .map(text => String(text ?? '').replace(/\r\n?/g, '\n').replace(SHOWN_CONTROL, '').trim())
    .filter(Boolean).join('\n')
  return new CommitError(detail ? detail.slice(0, ERROR_MAX) : '커밋하지 못했습니다.')
}

const headOf = (top) => run(top, ['rev-parse', '--verify', '--quiet', 'HEAD'], { timeout: STATUS_TIMEOUT_MS }).then(text => text.trim(), () => null)

/** New files added for a commit that did not happen go back to untracked (the files are not touched) */
function unadd(top, fresh) {
  if (!fresh.length) return Promise.resolve()
  return run(top, ['rm', '--cached', '--force', '--quiet', '--ignore-unmatch', ...FROM_STDIN], { input: nulList(fresh), timeout: ADD_TIMEOUT_MS }).catch(() => {})
}

async function committed(top, files, hash, warning) {
  const shortHash = (await run(top, ['rev-parse', '--short', hash], { timeout: STATUS_TIMEOUT_MS })).trim()
  return { hash, shortHash, count: files.length, ...(warning ? { warning } : {}) }
}

async function commitIn(top, files, message, commitTimeoutMs) {
  const entries = statusEntries(await run(top, ['status', '--porcelain=v1', '-z', '--untracked-files=all'], { timeout: STATUS_TIMEOUT_MS }))
  const byPath = new Map(entries.map(entry => [entry.path, entry]))
  const missing = files.filter(file => !byPath.has(file))
  if (missing.length) throw new CommitError(`변경 목록이 바뀌었습니다. 새로 고친 뒤 다시 골라 주세요 (목록에 없는 파일 ${missing.length}개).`)
  if (files.some(file => byPath.get(file).unmerged)) throw new CommitError('충돌한 파일은 충돌을 해결한 뒤 커밋할 수 있습니다.')
  // "sub/" is another repository inside this one: adding it would commit a link to it, rarely meant
  if (files.some(file => file.endsWith('/'))) throw new CommitError('이 저장소 안의 다른 저장소는 여기서 커밋할 수 없습니다.')
  // New files are not known to Git yet: `commit --only` needs them in the index first
  const fresh = files.filter(file => byPath.get(file).x === '?')
  // A staged rename commits the old path's removal with it (a copy leaves its source alone)
  const renamedFrom = files.filter(file => byPath.get(file).x === 'R').map(file => byPath.get(file).from).filter(Boolean)
  const pathspecs = [...new Set([...files, ...renamedFrom])]
  const before = await headOf(top)
  if (fresh.length) {
    try {
      await run(top, ['add', ...FROM_STDIN], { input: nulList(fresh), timeout: ADD_TIMEOUT_MS })
    } catch (error) {
      await unadd(top, fresh)
      throw commitFailure(error, '새 파일을 추가하지 못했습니다 (시간 초과).')
    }
  }
  try {
    await run(top, ['commit', '--only', '--cleanup=whitespace', '-m', message, ...FROM_STDIN], { input: nulList(pathspecs), timeout: commitTimeoutMs })
  } catch (error) {
    // Stopped after the commit was made (a post-commit hook that hangs, or too much output): it stays
    const after = await headOf(top)
    if (after && after !== before) return committed(top, files, after, '커밋한 뒤에 실행된 훅이 끝나지 않았거나 출력이 너무 길었습니다.')
    await unadd(top, fresh)
    throw commitFailure(error, `커밋이 ${COMMIT_TIMEOUT_MS / 60000}분 안에 끝나지 않아 멈췄습니다. 훅이 멈춰 있지 않은지, .git/index.lock 이 남지 않았는지 확인해 주세요.`)
  }
  const hash = await headOf(top)
  if (!hash) throw new CommitError('커밋한 뒤 HEAD 를 읽지 못했습니다.')
  return committed(top, files, hash)
}

/**
 * Commits `files` (paths relative to the repository top, from the status list) with `message` in the
 * repository of `folder`, a folder main already accepted. One commit at a time per repository.
 * `commitTimeoutMs` is for tests (main uses the default).
 */
async function commitSelected(folder, { files, message } = {}, { commitTimeoutMs = COMMIT_TIMEOUT_MS } = {}) {
  const text = requireCommitMessage(message)
  const wanted = requireFiles(files)
  const top = await repoTop(folder)
  if (!top) throw new CommitError('Git 저장소가 아닌 폴더입니다.')
  const key = repoKey(top)
  if (committing.has(key)) throw new CommitError('이 저장소에서 커밋하는 중입니다. 끝난 뒤 다시 시도해 주세요.')
  committing.add(key)
  try {
    return await commitIn(top, wanted, text, commitTimeoutMs)
  } finally {
    committing.delete(key)
  }
}

module.exports = { commitSelected, requireCommitMessage, CommitError }
