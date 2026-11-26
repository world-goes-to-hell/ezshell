const { execFile } = require('child_process')
const { promisify } = require('util')
const fs = require('fs')
const path = require('path')
const { requireLocalDirectory } = require('../localShell.js')
const { isLocalFilePath } = require('../localKeyPath.js')
const { readRepoTop, clearReadRepoCache, SAFE } = require('../localFiles/git.js')
const { createDirectorySearch } = require('../localFiles/search.js')
const { searchContent, checkContentQuery } = require('../localFiles/contentSearch.js')
const { inspectDevelopmentTasks, prepareDevelopmentTask } = require('./localDevelopmentTasks.js')

const exec = promisify(execFile)
const DIRECTORY_LIMIT = 1000
const COMMIT_LIMIT = 100
const REPOSITORY_SCAN_LIMIT = 512
const REPOSITORY_SCAN_BATCH = 16
const REPOSITORY_SCAN_TTL_MS = 10000
const REPOSITORY_SCAN_TIMEOUT_MS = 15000
const REPOSITORY_SCAN_CACHE_MAX = 20
const REPOSITORY_SCAN_SKIP = new Set(['.git', 'node_modules'])
const repositoryScans = new Map()
const LOG_OPTIONS = ['log', '-z', '--no-color', '--no-show-signature', '--decorate=short', '--encoding=UTF-8', '--format=%H%x00%P%x00%h%x00%an%x00%aI%x00%s%x00%D']

async function git(cwd, args, { timeout = 15000, signal } = {}) {
  const { stdout } = await exec('git', args, {
    cwd, timeout, signal, windowsHide: true, encoding: 'utf8', maxBuffer: 4 * 1024 * 1024
  })
  return stdout
}

function parseWorktrees(output, includeHead) {
  return output.split('\0\0').flatMap(record => {
    const fields = record.split('\0')
    const location = fields[0]?.startsWith('worktree ') && fields[0].slice(9)
    if (!location || fields.includes('bare') || fields.some(field => /^prunable(?: |$)/.test(field))) return []
    const branch = fields.find(field => field.startsWith('branch refs/heads/'))?.slice(18) ?? null
    const head = includeHead && fields.find(field => /^HEAD (?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(field))?.slice(5)
    return [{
      path: path.normalize(location), branch,
      ...(head && (branch || fields.includes('detached')) && { head: /^0+$/.test(head) ? null : head })
    }]
  })
}

const listWorktrees = (root, includeHead = false) => git(root, [...SAFE, 'worktree', 'list', '--porcelain', '-z'])
  .then(output => parseWorktrees(output, includeHead))

async function findNestedRepositories(root, signal) {
  const directories = [root]
  const repositories = []
  // Read nearby folders first. Symlinks and dependency trees are excluded from discovery.
  for (let first = 0; first < directories.length;) {
    signal.throwIfAborted()
    const batch = directories.slice(first, first + REPOSITORY_SCAN_BATCH)
    first += batch.length
    const visited = await Promise.all(batch.map(async directory => {
      const real = await fs.promises.realpath(directory).catch(() => null)
      if (!real || path.relative(directory, real) !== '') return null
      const entries = await fs.promises.readdir(real, { withFileTypes: true }).catch(() => [])
      return { real, entries }
    }))
    for (const folder of visited) {
      if (!folder) continue
      const { real, entries } = folder
      if (path.relative(root, real) !== '' && entries.some(entry => entry.name === '.git' && (entry.isDirectory() || entry.isFile()))) {
        repositories.push(real)
      }
      for (const entry of entries) {
        if (directories.length >= REPOSITORY_SCAN_LIMIT) break
        if (entry.isDirectory() && !REPOSITORY_SCAN_SKIP.has(entry.name.toLowerCase())) directories.push(path.join(real, entry.name))
      }
    }
  }
  return repositories
}

function nestedRepositoriesOf(root) {
  const cached = repositoryScans.get(root)
  if (cached && cached.until > Date.now()) return cached.read
  const controller = new AbortController()
  let timer
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => {
      const error = new Error('하위 Git 저장소를 찾는 시간이 초과되었습니다.')
      controller.abort(error)
      reject(error)
    }, REPOSITORY_SCAN_TIMEOUT_MS)
  })
  const read = Promise.race([findNestedRepositories(root, controller.signal), deadline])
    .finally(() => clearTimeout(timer))
  const entry = { until: Infinity, read }
  repositoryScans.delete(root)
  repositoryScans.set(root, entry)
  if (repositoryScans.size > REPOSITORY_SCAN_CACHE_MAX) repositoryScans.delete(repositoryScans.keys().next().value)
  entry.read.then(() => { entry.until = Date.now() + REPOSITORY_SCAN_TTL_MS }, () => {
    if (repositoryScans.get(root) === entry) repositoryScans.delete(root)
  })
  return entry.read
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
  const worktrees = await listWorktrees(root)
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

async function readWorkspaceGit(folder, includeAllBranches = false) {
  const cwd = requireLocalDirectory(folder)
  let root
  try {
    root = await readRepoTop(cwd)
  } catch (error) {
    if (error.code === 'ENOENT') return { repo: null, reason: 'git-missing' }
    if (error.code === 128 && /not a git repository/i.test(error.stderr ?? '')) return { repo: null, reason: 'not-repo' }
    throw error
  }

  const nested = nestedRepositoriesOf(root)
  const listed = await listWorktrees(root, true).catch(() => [])
  const current = listed.findIndex(tree => path.relative(root, tree.path) === '')
  const checkout = listed[current]
  const [head, branch] = checkout?.head !== undefined ? [checkout.head, checkout.branch] : await Promise.all([
    git(root, [...SAFE, 'rev-parse', '--verify', '--quiet', 'HEAD']).then(text => text.trim(), missingHead),
    git(root, [...SAFE, 'symbolic-ref', '--quiet', '--short', 'HEAD']).then(text => text.trim(), missingHead)
  ])
  const worktrees = listed.map(({ path, branch }) => ({ path, branch }))
  const active = { path: root, branch }
  if (current < 0) worktrees.unshift(active)
  else worktrees[current] = active
  const allBranches = includeAllBranches || worktrees.length < 2
  const refs = [...(allBranches ? ['--all'] : []), ...(head ? ['HEAD'] : [])]
  const [log, discovered] = await Promise.all([
    refs.length ? git(root, [...SAFE, ...LOG_OPTIONS, '--topo-order', `--max-count=${COMMIT_LIMIT + 1}`, ...refs, '--']) : '',
    nested
  ])
  const nestedRepositories = discovered.filter(folder => !worktrees.some(tree => path.relative(folder, tree.path) === ''))
  const commits = parseCommits(log)
  return { repo: { root, head, branch, worktrees, nestedRepositories, allBranches, commits: commits.slice(0, COMMIT_LIMIT), hasMore: commits.length > COMMIT_LIMIT } }
}

function missingHead(error) {
  if (error.code === 1) return null
  throw error
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

async function searchWorkspaceGit(root, query, signal, worktreeOnly) {
  const head = await git(root, ['rev-parse', '--verify', '--quiet', 'HEAD'], { signal }).then(text => text.trim(), missingHead)
  if (worktreeOnly && !head) return { commits: [], hasMore: false }
  const filters = [...(worktreeOnly ? [] : ['--all']), '--date-order', '--fixed-strings', '--regexp-ignore-case', `--max-count=${COMMIT_LIMIT + 1}`]
  const search = option => git(root, ['--no-pager', ...LOG_OPTIONS, ...filters, option, ...(head ? [head] : []), '--'], { signal }).then(parseCommits)

  const prefix = query.toLowerCase()
  const findHash = async () => {
    if (!/^[a-f0-9]{4,64}$/.test(prefix)) return []
    const resolved = await git(root, ['rev-parse', '--verify', '--quiet', '--end-of-options', `${prefix}^{commit}`], { signal }).then(text => text.trim(), error => {
      if (error.code === 1 || error.code === 128) return ''
      throw error
    })
    if (!resolved.startsWith(prefix)) return []
    if (worktreeOnly) {
      const reachable = await git(root, ['merge-base', '--is-ancestor', resolved, head], { signal }).then(() => true, error => {
        if (error.code === 1) return false
        throw error
      })
      if (!reachable) return []
    }
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
function registerLocalProjectIpc({ ipcMain, fromMainWindow, isLocked, roots = null, git: localGit = null, gitCommit = null, openDevelopmentTask, changeDevelopmentTask, openFolder = null }) {
  const directorySearch = createDirectorySearch()
  let searchGeneration = 0
  let preparation = 0
  const checkSearch = (generation) => {
    if (isLocked() || generation !== searchGeneration) throw new Error('잠금 해제 후 이용할 수 있습니다.')
  }
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
    handle(channel, fallback, async ({ root, query, worktreeOnly, includeAll } = {}) => {
      const term = requireSearchQuery(query)
      const generation = searchGeneration
      pending?.abort()
      const controller = new AbortController()
      pending = controller
      try {
        const folder = await roots.resolveRoot(root)
        controller.signal.throwIfAborted()
        checkSearch(generation)
        const result = await run(folder, term, controller.signal, worktreeOnly === true, includeAll === true)
        checkSearch(generation)
        return result
      } finally {
        if (pending === controller) pending = null
      }
    })
  }
  handle('local-project-inspect', '폴더의 Git 정보를 읽지 못했습니다.', inspectLocalProject)
  // 파일 탐색기로 열기 (the sidebar's project and worktree menu). openFolder (shell.openPath) runs a file, so
  // only a real folder of this PC goes to it: checked before any access, a UNC path can send Windows credentials.
  if (openFolder) ipcMain.handle('local-project-open-folder', async (event, folder) => {
    if (!fromMainWindow(event) || event.senderFrame !== event.sender.mainFrame || isLocked()) {
      return { success: false, error: '잠금 해제 후 본창에서 이용할 수 있습니다.' }
    }
    let real
    try {
      if (!isLocalFilePath(folder)) throw new Error('not local')
      real = await fs.promises.realpath(requireLocalDirectory(folder))
      if (!isLocalFilePath(real) || !(await fs.promises.stat(real)).isDirectory()) throw new Error('not a folder')
    } catch {
      return { success: false, error: '폴더를 찾을 수 없습니다.' }
    }
    if (!fromMainWindow(event) || isLocked()) return { success: false, error: '잠금 해제 후 본창에서 이용할 수 있습니다.' }
    const failure = await openFolder(real).catch(() => 'failed')
    return failure ? { success: false, error: '파일 탐색기로 열지 못했습니다.' } : { success: true }
  })
  handle('local-worktree-create', '워크트리를 만들지 못했습니다.', createLocalWorktree)
  if (openDevelopmentTask) {
    const preparing = new Map()
    const canLaunch = event => fromMainWindow(event) && event.senderFrame === event.sender.mainFrame && !isLocked()
    const startError = error => ({ success: false, error })
    const locked = '잠금 해제 후 본창에서 이용할 수 있습니다.'
    ipcMain.handle('local-project-development-tasks', async (event, folder) => {
      if (!canLaunch(event)) return startError(locked)
      try {
        const { tasks } = await inspectDevelopmentTasks(folder)
        return canLaunch(event) ? { success: true, tasks } : startError(locked)
      } catch (error) {
        return startError(error.code ? '기동할 프로젝트를 읽지 못했습니다.' : error.message)
      }
    })
    ipcMain.handle('local-project-development-start', async (event, request) => {
      if (!canLaunch(event)) return startError(locked)
      const { folder, id, includeSource, install, cols, rows } = request ?? {}
      if (typeof folder !== 'string' || typeof id !== 'string' || id.length > 300) return startError('기동할 프로젝트를 선택해 주세요.')
      const normalized = path.normalize(folder)
      const key = process.platform === 'win32' ? normalized.toLowerCase() : normalized
      if (preparing.has(key)) return startError('이 작업의 기동 준비가 진행 중입니다.')
      preparing.set(key, true)
      try {
        const task = await prepareDevelopmentTask(folder, id, {
          includeSource: includeSource === true, install: install === true, allowed: () => canLaunch(event)
        })
        if (!canLaunch(event)) return startError(locked)
        return { success: true, ...await openDevelopmentTask(task, { cols, rows }, () => canLaunch(event)) }
      } catch (error) {
        return startError(error.stderr?.trim().slice(0, 300) || (error.code ? '개발 서버를 기동하지 못했습니다.' : error.message))
      } finally { preparing.delete(key) }
    })
    if (changeDevelopmentTask) ipcMain.handle('local-project-development-change', async (event, request) => {
      if (!canLaunch(event)) return startError(locked)
      const { shellId, taskId, action } = request ?? {}
      if (typeof shellId !== 'string' || typeof taskId !== 'string' || taskId.length > 300) return startError('기동한 개발 서버를 찾을 수 없습니다.')
      try {
        await changeDevelopmentTask(shellId, taskId, action, () => canLaunch(event))
        return { success: true }
      } catch (error) {
        return startError(error.code ? '개발 서버를 전환하지 못했습니다.' : error.message)
      }
    })
  }
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
  if (roots && gitCommit) {
    // The panel's one write (docs/plan/2026-11-24-workspace-git-commit.md): only the main window's own
    // frame, unlocked. The window names files of the change list; gitCommit checks them against Git.
    const canCommit = event => fromMainWindow(event) && event.senderFrame === event.sender.mainFrame && !isLocked()
    const locked = { success: false, error: '잠금 해제 후 본창에서 이용할 수 있습니다.' }
    ipcMain.handle('workspace-git-commit', async (event, { root, files, message } = {}) => {
      if (!canCommit(event)) return locked
      try {
        // Narrower than reading: a repository of an open shell (or one inside it), not any folder below one
        const result = await gitCommit.commitSelected(await roots.resolveRepoRoot(root), { files, message })
        return { success: true, ...result }
      } catch (error) {
        return { success: false, error: error.userMessage || '커밋하지 못했습니다.' }
      }
    })
  }
  handle('workspace-git-log', 'Git 기록을 읽지 못했습니다.', async input => {
    const { folder, allBranches } = typeof input === 'string' ? { folder: input } : input ?? {}
    const cwd = roots ? await roots.resolveRoot(folder, { refreshWorktreesOnMiss: true }) : folder
    return readWorkspaceGit(cwd, allBranches === true)
  })
  if (roots) {
    handle('workspace-directory-prepare', '폴더를 검색하지 못했습니다.', async ({ root, refresh, includeAll } = {}) => {
      const generation = searchGeneration
      const request = ++preparation
      const folder = await roots.resolveRoot(root)
      checkSearch(generation)
      if (request === preparation) directorySearch.prepare(folder, refresh === true, includeAll === true)
      return {}
    })
    handleSearch('workspace-directory-search', '폴더를 검색하지 못했습니다.', directorySearch.search)
    // 프로젝트 검색's content search: a new one ends the one before (its git grep is stopped)
    let contentSearch = null
    handle('workspace-content-search', '파일 내용을 검색하지 못했습니다.', async ({ root, query, caseSensitive } = {}) => {
      checkContentQuery(query)
      contentSearch?.abort()
      const controller = new AbortController()
      contentSearch = controller
      try {
        const folder = await roots.resolveRoot(root)
        const result = await searchContent(folder, query, { caseSensitive: caseSensitive === true, signal: controller.signal })
        if (isLocked()) throw new Error('잠금 해제 후 이용할 수 있습니다.')
        return result
      } finally {
        if (contentSearch === controller) contentSearch = null
      }
    })
    handleSearch('workspace-git-search', 'Git 기록을 검색하지 못했습니다.', searchWorkspaceGit)
  }
  return {
    clearSearches() {
      searchGeneration++
      directorySearch.clear()
      repositoryScans.clear()
      clearReadRepoCache()
    }
  }
}

module.exports = { registerLocalProjectIpc, inspectLocalProject, createLocalWorktree, listWorkspaceDirectory, readWorkspaceGit }
