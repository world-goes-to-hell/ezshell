const { execFile } = require('child_process')
const { promisify } = require('util')
const fs = require('fs')
const path = require('path')
const { requireLocalDirectory } = require('../localShell.js')
const { searchDirectory } = require('../localFiles/search.js')

const exec = promisify(execFile)
const DIRECTORY_LIMIT = 1000
const COMMIT_LIMIT = 100
const LOG_OPTIONS = ['log', '-z', '--no-color', '--no-show-signature', '--decorate=short', '--encoding=UTF-8', '--format=%H%x00%P%x00%h%x00%an%x00%aI%x00%s%x00%D']

async function git(cwd, args, { timeout = 15000, signal } = {}) {
  const { stdout } = await exec('git', args, {
    cwd, timeout, signal, windowsHide: true, encoding: 'utf8', maxBuffer: 4 * 1024 * 1024
  })
  return stdout
}

function parseWorktrees(output) {
  return output.split('\0\0').flatMap(record => {
    const fields = record.split('\0')
    const location = fields[0]?.startsWith('worktree ') && fields[0].slice(9)
    if (!location || fields.includes('bare') || fields.some(field => /^prunable(?: |$)/.test(field))) return []
    const branch = fields.find(field => field.startsWith('branch refs/heads/'))?.slice(18) ?? null
    return [{ path: path.normalize(location), branch }]
  })
}

async function inspectLocalProject(folder) {
  const cwd = requireLocalDirectory(folder)
  let root
  try {
    root = path.normalize((await git(cwd, ['rev-parse', '--show-toplevel'])).replace(/\r?\n$/, ''))
  } catch (error) {
    if (error.code === 'ENOENT') return { repo: null, gitMissing: true }
    if (error.code === 128) return { repo: null, gitMissing: false }
    throw error
  }
  const worktrees = parseWorktrees(await git(root, ['worktree', 'list', '--porcelain', '-z']))
  const branch = worktrees.find(tree => path.relative(root, tree.path) === '')?.branch ?? null
  return { repo: { root, branch, worktrees }, gitMissing: false }
}

async function listWorkspaceDirectory(folder) {
  const directory = requireLocalDirectory(folder)
  // The repository's own data is not browsed
  const entries = (await fs.promises.readdir(directory, { withFileTypes: true })).filter(entry => entry.name !== '.git')
  entries.sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name))
  return {
    entries: entries.slice(0, DIRECTORY_LIMIT).map(entry => ({
      name: entry.name,
      kind: entry.isDirectory() ? 'directory' : entry.isSymbolicLink() ? 'link' : 'file'
    })),
    total: entries.length
  }
}

async function readWorkspaceGit(folder) {
  const cwd = requireLocalDirectory(folder)
  let root
  try {
    root = path.normalize((await git(cwd, ['rev-parse', '--show-toplevel'])).replace(/\r?\n$/, ''))
  } catch (error) {
    if (error.code === 'ENOENT') return { repo: null, reason: 'git-missing' }
    if (error.code === 128 && /not a git repository/i.test(error.stderr ?? '')) return { repo: null, reason: 'not-repo' }
    throw error
  }

  const head = await git(root, ['rev-parse', '--verify', '--quiet', 'HEAD']).then(text => text.trim(), error => {
    if (error.code === 1) return null
    throw error
  })
  const branch = await git(root, ['symbolic-ref', '--quiet', '--short', 'HEAD']).then(text => text.trim(), error => {
    if (error.code === 1) return null
    throw error
  })
  const log = await git(root, [
    ...LOG_OPTIONS, '--all', '--topo-order', `--max-count=${COMMIT_LIMIT + 1}`,
    ...(head ? ['HEAD'] : []), '--'
  ])
  const commits = parseCommits(log)
  return { repo: { root, head, branch, commits: commits.slice(0, COMMIT_LIMIT), hasMore: commits.length > COMMIT_LIMIT } }
}

function parseCommits(log) {
  const fields = log.split('\0')
  const commits = []
  for (let offset = 0; offset + 7 < fields.length; offset += 7) {
    const [hash, parents, shortHash, author, time, subject, refs] = fields.slice(offset, offset + 7)
    commits.push({ hash, parents: parents ? parents.split(' ') : [], shortHash, author, time, subject, refs: refs ? refs.split(', ') : [] })
  }
  return commits
}

async function searchWorkspaceGit(root, query, signal) {
  const head = await git(root, ['rev-parse', '--verify', '--quiet', 'HEAD'], { signal }).then(text => text.trim(), error => {
    if (error.code === 1) return ''
    throw error
  })
  const filters = ['--all', '--date-order', '--fixed-strings', '--regexp-ignore-case', `--max-count=${COMMIT_LIMIT + 1}`]
  const search = option => git(root, ['--no-pager', ...LOG_OPTIONS, ...filters, option, ...(head ? [head] : []), '--'], { signal }).then(parseCommits)

  const prefix = query.toLowerCase()
  const findHash = async () => {
    if (!/^[a-f0-9]{4,64}$/.test(prefix)) return []
    const resolved = await git(root, ['rev-parse', '--verify', '--quiet', '--end-of-options', `${prefix}^{commit}`], { signal }).then(text => text.trim(), error => {
      if (error.code === 1 || error.code === 128) return ''
      throw error
    })
    if (!resolved.startsWith(prefix)) return []
    return parseCommits(await git(root, ['--no-pager', ...LOG_OPTIONS, '--max-count=1', resolved, '--'], { signal }))
  }

  const groups = await Promise.all([search(`--grep=${query}`), search(`--author=${query}`), findHash()])
  const matches = new Map(groups.flat().map(commit => [commit.hash, commit]))
  const commits = [...matches.values()].sort((a, b) => Date.parse(b.time) - Date.parse(a.time))
  return { commits: commits.slice(0, COMMIT_LIMIT), hasMore: commits.length > COMMIT_LIMIT }
}

async function createLocalWorktree({ folder, branch, base } = {}) {
  const root = requireLocalDirectory(folder)
  if (typeof branch !== 'string' || !branch || branch.startsWith('-')) {
    throw new Error('새 브랜치 이름을 입력해 주세요.')
  }
  if (typeof base !== 'string' || !base) throw new Error('기준 브랜치 또는 커밋을 입력해 주세요.')
  try {
    await git(root, ['check-ref-format', 'refs/heads/' + branch])
  } catch {
    throw new Error('새 브랜치 이름이 올바르지 않습니다.')
  }
  let commit
  try {
    commit = (await git(root, ['rev-parse', '--verify', '--end-of-options', base + '^{commit}'])).trim()
  } catch {
    throw new Error('기준 브랜치 또는 커밋을 찾을 수 없습니다.')
  }

  // Put the new checkout next to the repository. Git handles branch and destination collisions.
  const repoRoot = path.normalize((await git(root, ['rev-parse', '--show-toplevel'])).replace(/\r?\n$/, ''))
  const suffix = branch.replace(/[<>:"/\\|?*\u0000-\u001f]/g, '-')
  const location = path.join(path.dirname(repoRoot), `${path.basename(repoRoot)}-${suffix}`)
  await git(repoRoot, ['worktree', 'add', '-b', branch, '--', location, commit], { timeout: 0 })
  return { path: location, branch }
}

function requireSearchQuery(value) {
  if (typeof value !== 'string' || value.length > 200 || !value.trim() || /[\r\n\0]/.test(value)) {
    throw new Error('검색어를 확인해 주세요.')
  }
  return value.trim()
}

/**
 * `roots` (src/localFiles/roots.js) checks the folders the workspace panel reads, `git` is
 * src/localFiles/git.js. Requests name a root and a path relative to it.
 */
function registerLocalProjectIpc({ ipcMain, fromMainWindow, isLocked, roots = null, git: localGit = null }) {
  const handle = (channel, fallback, run) => {
    ipcMain.handle(channel, async (event, input) => {
      if (!fromMainWindow(event) || isLocked()) return { success: false, error: '잠금 해제 후 본창에서 이용할 수 있습니다.' }
      try {
        return { success: true, ...await run(input) }
      } catch (error) {
        const detail = error.stderr?.trim() || (error.code ? '' : error.message)
        return { success: false, error: detail ? detail.slice(0, 500) : fallback }
      }
    })
  }
  const handleSearch = (channel, fallback, run) => {
    let pending
    handle(channel, fallback, async ({ root, query } = {}) => {
      const term = requireSearchQuery(query)
      pending?.abort()
      const controller = new AbortController()
      pending = controller
      try {
        const folder = await roots.resolveRoot(root)
        controller.signal.throwIfAborted()
        const result = await run(folder, term, controller.signal)
        if (isLocked()) throw new Error('잠금 해제 후 이용할 수 있습니다.')
        return result
      } finally {
        if (pending === controller) pending = null
      }
    })
  }
  handle('local-project-inspect', '폴더의 Git 정보를 읽지 못했습니다.', inspectLocalProject)
  handle('local-worktree-create', '워크트리를 만들지 못했습니다.', createLocalWorktree)
  // A folder inside the panel's root ({ root, path }); a bare string is the root itself (older windows)
  handle('workspace-directory-list', '폴더 목록을 읽지 못했습니다.', async (input) => {
    if (!roots) return listWorkspaceDirectory(input)
    const request = typeof input === 'string' ? { root: input, path: '' } : input ?? {}
    const found = await roots.resolveInside(request.root, typeof request.path === 'string' ? request.path : '')
    return listWorkspaceDirectory(found.path)
  })
  if (roots && localGit) {
    handle('workspace-git-status', '커밋하지 않은 변경을 읽지 못했습니다.', async (root) => localGit.status(await roots.resolveRoot(root)))
    handle('workspace-git-commit-files', '커밋의 파일을 읽지 못했습니다.', async ({ root, hash } = {}) => localGit.commitFiles(await roots.resolveRoot(root), hash))
    // `file` is relative to the repository top (as the status and commit lists give it)
    handle('workspace-git-diff', '변경 내용을 읽지 못했습니다.', async ({ root, hash, file } = {}) =>
      localGit.fileDiff(await roots.resolveRoot(root), { hash: hash || undefined, file }))
  }
  handle('workspace-git-log', 'Git 기록을 읽지 못했습니다.', readWorkspaceGit)
  if (roots) {
    handleSearch('workspace-directory-search', '폴더를 검색하지 못했습니다.', searchDirectory)
    handleSearch('workspace-git-search', 'Git 기록을 검색하지 못했습니다.', searchWorkspaceGit)
  }
}

module.exports = { registerLocalProjectIpc, inspectLocalProject, createLocalWorktree, listWorkspaceDirectory, readWorkspaceGit }
