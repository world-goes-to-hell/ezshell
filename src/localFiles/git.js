// Read-only Git queries for the workspace panel: the uncommitted changes, the files of a commit, the
// diff of one file, and a file's content at a commit (docs/plan/2026-11-19-workspace-files-and-git-details.md).
// The folder is a real path main already accepted (roots.js). Paths go after `--` (or as `<rev>:<path>`
// relative to the repository top, checked here), commits must look like hashes. Nothing here writes.
// Loaded by main.js at runtime (copied to out/main/src), so keep it CommonJS and free of Electron imports.
const { execFile } = require('child_process')
const fs = require('fs')
const path = require('path')

const OUTPUT_MAX_BYTES = 4 * 1024 * 1024
const DIFF_MAX_BYTES = 400 * 1024
const DIFF_MAX_LINES = 3000
const FILE_MAX_BYTES = 5 * 1024 * 1024
const LIST_MAX = 2000
/** A new file is counted line by line only up to this size, and all new files together up to the total */
const COUNT_MAX_BYTES = 5 * 1024 * 1024
const COUNT_TOTAL_MAX_BYTES = 64 * 1024 * 1024
const TIMEOUT_MS = 15000
const READ_REPO_CACHE_MS = 10000
const READ_REPO_CACHE_MAX = 64
const readRepoCache = new Map()
let readRepoGeneration = 0
const HASH = /^[0-9a-f]{7,40}$/
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f]/
// A repository's own config could start programs on a read (core.fsmonitor on status); turn those off
const SAFE = ['-c', 'core.fsmonitor=false', '-c', 'core.quotepath=false', '-c', 'diff.external=', '--no-pager']

function run(cwd, args, { maxBuffer = OUTPUT_MAX_BYTES, encoding = 'utf8', env } = {}) {
  return new Promise((resolve, reject) => {
    execFile('git', [...SAFE, ...args], { cwd, timeout: TIMEOUT_MS, windowsHide: true, encoding, maxBuffer, env }, (error, stdout, stderr) => {
      if (error) {
        error.stderr = String(stderr ?? '')
        reject(error)
      } else {
        resolve(stdout)
      }
    })
  })
}

async function discoverRepoTop(folder) {
  return path.normalize((await run(folder, ['rev-parse', '--show-toplevel'])).replace(/\r?\n$/, ''))
}

/** The repository top of a folder, or null outside Git (or without Git) */
async function repoTop(folder) {
  try {
    return await discoverRepoTop(folder)
  } catch {
    return null
  }
}

/** Reuse a recent root for reads. A child directory can acquire its own repository at any time. */
async function readRepoTop(folder) {
  const generation = readRepoGeneration
  const key = path.resolve(folder)
  const cached = readRepoCache.get(key)
  if (cached && cached.until > Date.now()) {
    const marker = await fs.promises.lstat(path.join(key, '.git')).catch(() => null)
    if (marker?.isDirectory() || marker?.isFile()) return cached.top
  }
  const top = await discoverRepoTop(folder)
  if (generation === readRepoGeneration && path.relative(key, top) === '') {
    readRepoCache.delete(key)
    readRepoCache.set(key, { top, until: Date.now() + READ_REPO_CACHE_MS })
    if (readRepoCache.size > READ_REPO_CACHE_MAX) readRepoCache.delete(readRepoCache.keys().next().value)
  }
  return top
}

function clearReadRepoCache() {
  readRepoGeneration++
  readRepoCache.clear()
}

/** The repository top and its worktrees, for the roots main accepts */
async function repoFolders(folder) {
  const top = await repoTop(folder)
  if (!top) return []
  const list = await run(top, ['worktree', 'list', '--porcelain', '-z']).catch(() => '')
  const trees = list.split('\0').filter(field => field.startsWith('worktree ')).map(field => path.normalize(field.slice(9)))
  return [top, ...trees]
}

async function hasHead(top) {
  return run(top, ['rev-parse', '--verify', '--quiet', 'HEAD']).then(() => true, () => false)
}

/** A path relative to the repository top, with forward slashes; null when it is not inside it */
function repoPath(top, target) {
  const relative = path.relative(top, target)
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative) || CONTROL.test(relative)) return null
  return relative.split(path.sep).join('/')
}

const KINDS = { M: 'modified', A: 'added', D: 'deleted', R: 'renamed', C: 'copied', T: 'modified', U: 'conflict' }
// Unmerged pairs of `git status`: either side U, or both added / both deleted
const UNMERGED = /^(?:U.|.U|AA|DD)$/

/** The entries of `git status --porcelain=v1 -z`: { path, x, y, from?, unmerged }, at most LIST_MAX */
function statusEntries(output) {
  const fields = output.split('\0')
  const entries = []
  for (let index = 0; index < fields.length && entries.length < LIST_MAX; index++) {
    const field = fields[index]
    if (field.length < 4) continue
    const x = field[0]
    const y = field[1]
    const file = field.slice(3)
    const renamedFrom = x === 'R' || x === 'C' ? fields[++index] : undefined
    entries.push({ path: file, x, y, ...(renamedFrom ? { from: renamedFrom } : {}), unmerged: UNMERGED.test(x + y) })
  }
  return entries
}

/** `git status -z` (v1): staged, changed in the work tree, untracked; paths relative to the top */
function parseStatus(output) {
  const entries = statusEntries(output)
  const kindOf = (e, letter) => (e.unmerged ? 'conflict' : KINDS[letter] ?? 'modified')
  const staged = entries.filter(e => e.x !== ' ' && e.x !== '?' && e.x !== '!').map(e => ({ path: e.path, kind: kindOf(e, e.x), ...(e.from ? { from: e.from } : {}) }))
  const changed = entries.filter(e => e.y !== ' ' && e.x !== '?' && e.y !== '?').map(e => ({ path: e.path, kind: kindOf(e, e.y) }))
  const untracked = entries.filter(e => e.x === '?').map(e => ({ path: e.path, kind: 'untracked' }))
  return { staged, changed, untracked, truncated: entries.length >= LIST_MAX }
}

/**
 * `git diff --numstat -z`: { path: [added, removed] }, null counts for a binary file. A rename comes as
 * "a\tr\t" then the old and the new path; it is kept under the new path.
 */
function parseNumstat(output) {
  const stats = {}
  const fields = output.split('\0')
  for (let index = 0; index < fields.length; index++) {
    const match = /^(\d+|-)\t(\d+|-)\t([\s\S]*)$/.exec(fields[index])
    if (!match) continue
    let file = match[3]
    if (file === '') {
      file = fields[index + 2]
      index += 2
    }
    if (!file) continue
    stats[file] = [match[1] === '-' ? null : Number(match[1]), match[2] === '-' ? null : Number(match[2])]
  }
  return stats
}

/** The lines of a new file: null for a link, a file outside the repository, a large or binary file */
async function countNewFile(top, relative, budget) {
  const target = path.join(top, relative)
  if (repoPath(top, target) === null) return null
  try {
    const stats = await fs.promises.lstat(target)
    if (!stats.isFile() || stats.size > COUNT_MAX_BYTES || stats.size > budget.left) return null
    budget.left -= stats.size
    const data = await fs.promises.readFile(target)
    if (data.includes(0)) return null
    if (data.length === 0) return 0
    let lines = 0
    for (let at = data.indexOf(10); at !== -1; at = data.indexOf(10, at + 1)) lines++
    return data[data.length - 1] === 10 ? lines : lines + 1
  } catch {
    return null
  }
}

/** The `##` record of `git status --porcelain=v1 --branch -z` in the C locale. */
function parseStatusBranch(header) {
  if (/^## (?:No commits yet on|Initial commit on) /u.test(header)) {
    return { hasHead: false, branch: null, upstream: null }
  }
  const [branch, tracking] = header.slice(3).split('...')
  const upstream = tracking?.endsWith(' [gone]') ? null : tracking?.split(' ')[0] || null
  return { hasHead: true, branch: branch === 'HEAD (no branch)' ? null : branch, upstream }
}

async function status(folder) {
  const top = await readRepoTop(folder).catch(() => null)
  if (!top) return { repo: null }
  const diff = against => run(top, ['diff', '--numstat', '-z', '--no-renames', against, '--']).catch(() => '')
  const [output, headStats] = await Promise.all([
    run(top, ['--no-optional-locks', 'status', '--porcelain=v1', '-z', '--branch', '--no-ahead-behind', '--untracked-files=all'],
      { env: { ...process.env, LC_ALL: 'C' } }),
    diff('HEAD')
  ])
  const headerEnd = output.indexOf('\0')
  const header = output.slice(0, headerEnd)
  const { hasHead, branch, upstream: tracking } = parseStatusBranch(header)
  const parsed = parseStatus(output.slice(headerEnd + 1))
  // Lines added / removed against HEAD (staged and not), and the lines of each new file
  // An unborn branch's status can report [gone] even when its configured upstream exists.
  const [numstat, upstream] = await Promise.all([
    hasHead ? headStats : diff('--cached'),
    !hasHead && header.includes('...') ? run(top, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'])
      .then(text => text.trim() || null, () => null) : tracking
  ])
  const stats = parseNumstat(numstat)
  const budget = { left: COUNT_TOTAL_MAX_BYTES }
  for (const file of parsed.untracked.slice(0, LIST_MAX)) {
    const lines = await countNewFile(top, file.path, budget)
    stats[file.path] = [lines, lines === null ? null : 0]
  }
  return { repo: { top, ...parsed, stats, branch, upstream } }
}

/** `git show --name-status -z`: [{ path, kind, from? }] */
function parseNameStatus(output) {
  const fields = output.split('\0').filter((field, index, all) => field !== '' || index < all.length - 1)
  const files = []
  for (let index = 0; index < fields.length && files.length < LIST_MAX; index++) {
    const code = fields[index]
    if (!code) continue
    const letter = code[0]
    if (letter === 'R' || letter === 'C') {
      const from = fields[++index]
      const to = fields[++index]
      if (to) files.push({ path: to, kind: KINDS[letter], from })
    } else {
      const file = fields[++index]
      if (file) files.push({ path: file, kind: KINDS[letter] ?? 'modified' })
    }
  }
  return files
}

function requireHash(hash) {
  if (typeof hash !== 'string' || !HASH.test(hash)) throw new Error('커밋을 찾지 못했습니다.')
  return hash
}

function requireRepoPath(file) {
  if (typeof file !== 'string' || !file || CONTROL.test(file) || file.startsWith('/') || file.startsWith(':') || file.split('/').includes('..') || /^[a-zA-Z]:/.test(file)) {
    throw new Error('열 수 없는 경로입니다.')
  }
  return file
}

async function commitFiles(folder, hash) {
  const top = await readRepoTop(folder).catch(() => null)
  if (!top) return { files: [] }
  const output = await run(top, ['show', '--no-color', '--format=', '--name-status', '-z', '--diff-merges=first-parent', requireHash(hash), '--'])
  return { files: parseNameStatus(output) }
}

/** Diff text cut to a size the panel can draw */
function cutDiff(text) {
  const lines = text.split('\n')
  const tooLong = text.length > DIFF_MAX_BYTES || lines.length > DIFF_MAX_LINES
  const kept = tooLong ? lines.slice(0, DIFF_MAX_LINES).join('\n').slice(0, DIFF_MAX_BYTES) : text
  return { text: kept, truncated: tooLong }
}

/**
 * The diff of one file (a path relative to the repository top): in a commit against its first parent,
 * or the work tree against HEAD. Binary files give `binary: true`.
 */
async function fileDiff(folder, { hash, file }) {
  const top = await readRepoTop(folder).catch(() => null)
  if (!top) return { text: '', truncated: false }
  const target = requireRepoPath(file)
  const common = ['--no-color', '--no-ext-diff', '--no-textconv']
  const args = hash
    ? ['show', ...common, '--format=', '--diff-merges=first-parent', requireHash(hash), '--', target]
    : (await hasHead(top)) ? ['diff', ...common, 'HEAD', '--', target] : ['diff', ...common, '--cached', '--', target]
  const output = await run(top, args, { maxBuffer: OUTPUT_MAX_BYTES })
  if (/^Binary files .* differ$/m.test(output)) return { text: '', truncated: false, binary: true }
  return cutDiff(output)
}

/** The file's text at HEAD (or a commit): null when the file is not in it or is not text */
async function fileAt(folder, target, rev = 'HEAD') {
  const top = await readRepoTop(folder).catch(() => null)
  if (!top) return null
  const relative = repoPath(top, target)
  if (!relative) return null
  if (rev !== 'HEAD') requireHash(rev)
  const spec = `${rev}:${requireRepoPath(relative)}`
  let size
  try {
    size = Number((await run(top, ['cat-file', '-s', spec])).trim())
  } catch {
    return null
  }
  if (!Number.isFinite(size) || size > FILE_MAX_BYTES) return null
  const [data, stamp] = await Promise.all([
    run(top, ['cat-file', 'blob', spec], { encoding: 'buffer', maxBuffer: FILE_MAX_BYTES + 1024 }),
    run(top, ['log', '-1', '--format=%ct', rev]).catch(() => '0')
  ])
  if (data.includes(0)) return null
  let content
  try {
    content = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(data)
  } catch {
    return null
  }
  const time = Number(stamp.trim()) * 1000
  return { content, size, time }
}

/** A file's revisions reachable from HEAD, using its path at each commit across renames. */
async function fileHistory(folder, target) {
  const top = await readRepoTop(folder).catch(() => null)
  if (!top) return []
  const file = repoPath(top, target)
  if (!file || !(await hasHead(top))) return []
  const output = await run(top, [
    '--literal-pathspecs', 'log', '--follow', '--find-renames', '--encoding=UTF-8', '--no-color', '--no-show-signature',
    '--name-status', '-z', '--format=%x00%H%x00%ct%x00%s', 'HEAD', '--', requireRepoPath(file)
  ])

  const fields = output.split('\0')
  const revisions = []
  const seen = new Set()
  for (let index = 0; index < fields.length - 1;) {
    if (fields[index++] !== '') throw new Error('Git 파일 이력을 읽지 못했습니다.')
    const hash = requireHash(fields[index++])
    const time = Number(fields[index++]) * 1000
    const subject = fields[index++]
    const changes = []
    while (index < fields.length && fields[index] !== '') {
      const status = fields[index++].trim()
      const from = fields[index++]
      const name = /^[RC]/.test(status) ? fields[index++] : from
      changes.push({ name, deleted: status === 'D' })
    }
    // --follow emits the path selected for this commit, even when it differed from the current path.
    const change = changes[0]
    if (!change?.name || seen.has(hash)) continue
    const historicalPath = path.resolve(top, requireRepoPath(change.name))
    if (!repoPath(top, historicalPath)) continue
    seen.add(hash)
    revisions.push({ hash, time, subject, path: historicalPath, deleted: change.deleted })
  }
  return revisions
}

module.exports = {
  repoTop, readRepoTop, clearReadRepoCache, repoFolders, status, commitFiles, fileDiff, fileAt, fileHistory,
  parseStatusBranch, parseStatus, statusEntries, parseNameStatus, parseNumstat, repoPath, requireRepoPath,
  SAFE, LIST_MAX, OUTPUT_MAX_BYTES
}
