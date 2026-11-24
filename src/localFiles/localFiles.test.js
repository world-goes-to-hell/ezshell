import { afterEach, describe, expect, it, vi } from 'vitest'
const fs = require('fs')
const os = require('os')
const path = require('path')
const { execFileSync } = require('child_process')
const { createLocalRoots } = require('./roots.js')
const localRead = require('./localRead.js')
const git = require('./git.js')
const { readWorkspaceGit, registerLocalProjectIpc } = require('../ipc/localProjects.js')

let temp
// A git process still closing can hold the folder on Windows for a moment: retry the removal
afterEach(() => { if (temp) fs.rmSync(temp, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); temp = undefined })

function repo({ unborn = false } = {}) {
  temp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ezshell-localfiles-')))
  const top = path.join(temp, 'app')
  fs.mkdirSync(path.join(top, 'src'), { recursive: true })
  const g = (...args) => execFileSync('git', args, { cwd: top, encoding: 'utf8' })
  g('init', '-q', '-b', 'main')
  g('config', 'user.email', 't@example.com')
  g('config', 'user.name', 'T')
  if (unborn) return { top, g }
  fs.writeFileSync(path.join(top, 'README.md'), 'one\n')
  fs.writeFileSync(path.join(top, 'src', 'a.txt'), 'alpha\n')
  g('add', '.')
  g('commit', '-q', '-m', 'first')
  fs.writeFileSync(path.join(top, 'src', 'a.txt'), 'alpha\nbeta\n')
  g('commit', '-q', '-am', 'second')
  return { top, g }
}

describe('roots', { timeout: 30000 }, () => {
  it('accepts the folder of an open shell and folders inside its repository, nothing else', async () => {
    const { top } = repo()
    const outside = fs.mkdtempSync(path.join(temp, 'other-'))
    const roots = createLocalRoots({ knownFolders: () => [path.join(top, 'src')], repoFolders: git.repoFolders })
    expect(await roots.resolveRoot(top)).toBe(top)
    expect(await roots.resolveRoot(path.join(top, 'src'))).toBe(path.join(top, 'src'))
    await expect(roots.resolveRoot(outside)).rejects.toThrow('열 수 없습니다')
    await expect(roots.resolveRoot('\\\\host\\share')).rejects.toThrow('열 수 없습니다')
  })

  it('resolves a path inside the root and refuses climbing out', async () => {
    const { top } = repo()
    const roots = createLocalRoots({ knownFolders: () => [top], repoFolders: async () => [] })
    expect((await roots.resolveInside(top, 'src/a.txt')).path).toBe(path.join(top, 'src', 'a.txt'))
    await expect(roots.resolveInside(top, '../x')).rejects.toThrow('열 수 없는 경로')
    await expect(roots.resolveInside(top, path.join(temp))).rejects.toThrow('열 수 없는 경로')
  })

  it('never resolves into a .git folder (its hooks and config run programs)', async () => {
    const { top } = repo()
    const roots = createLocalRoots({ knownFolders: () => [top], repoFolders: git.repoFolders })
    for (const relative of ['.git/hooks/pre-commit', '.git/config', '.GIT/config', 'src/../.git/config', '.git']) {
      await expect(roots.resolveInside(top, relative)).rejects.toThrow('열 수 없는 경로')
    }
    await expect(roots.resolveInside(path.join(top, '.git'), 'config')).rejects.toThrow('열 수 없는 경로')
    await expect(roots.resolveInside(path.join(top, '.git', 'hooks'), '')).rejects.toThrow('열 수 없는 경로')
    fs.writeFileSync(path.join(top, '.gitignore'), 'x\n')
    expect((await roots.resolveInside(top, '.gitignore')).relative).toBe('.gitignore')
  })

  it('commits only in a repository a shell is in, or one inside it', async () => {
    const { top, g } = repo()
    const nested = path.join(top, 'vendor', 'lib')
    fs.mkdirSync(nested, { recursive: true })
    execFileSync('git', ['init', '-q'], { cwd: nested })
    // A shell in a plain folder above both repositories: reading is allowed there, committing is not
    const elsewhere = path.join(temp, 'elsewhere')
    fs.mkdirSync(elsewhere)
    execFileSync('git', ['init', '-q'], { cwd: elsewhere })
    const roots = createLocalRoots({ knownFolders: () => [path.join(top, 'src'), temp], repoFolders: git.repoFolders })
    expect(await roots.resolveRepoRoot(top)).toBe(top)
    expect(await roots.resolveRepoRoot(nested)).toBe(nested)
    expect(await roots.resolveRoot(elsewhere)).toBe(elsewhere)
    await expect(roots.resolveRepoRoot(elsewhere)).rejects.toThrow('커밋')
    void g
  })
})

describe('localRead', () => {
  it('reads text to edit and saves only over what was read', async () => {
    const { top } = repo()
    const file = path.join(top, 'README.md')
    const { seen, canWrite } = await localRead.readForEdit(file)
    expect(seen.content).toBe('one\n')
    expect(canWrite).toBe(true)
    expect(await localRead.writeIfUnchanged(seen, 'two\n')).toEqual({ ok: true })
    expect(fs.readFileSync(file, 'utf8')).toBe('two\n')
    // Changed by someone else since: not written
    expect(await localRead.writeIfUnchanged(seen, 'three\n')).toEqual({ ok: false, conflict: true })
    expect(fs.readFileSync(file, 'utf8')).toBe('two\n')
  })

  it('refuses binary files for editing', async () => {
    const { top } = repo()
    const file = path.join(top, 'bin.dat')
    fs.writeFileSync(file, Buffer.from([1, 0, 2]))
    await expect(localRead.readForEdit(file)).rejects.toThrow('텍스트')
  })
})

// Real git processes: under a full parallel run they took more than vitest's default 5 seconds
describe('git', { timeout: 30000 }, () => {
  it('lists staged, changed and untracked files', async () => {
    const { top, g } = repo()
    fs.writeFileSync(path.join(top, 'README.md'), 'changed\n')
    fs.writeFileSync(path.join(top, 'src', 'new.txt'), 'n\n')
    fs.writeFileSync(path.join(top, 'src', 'a.txt'), 'staged\n')
    g('add', 'src/a.txt')
    const { repo: state } = await git.status(path.join(top, 'src'))
    expect(state.top).toBe(top)
    expect(state.staged).toEqual([{ path: 'src/a.txt', kind: 'modified' }])
    expect(state.changed).toEqual([{ path: 'README.md', kind: 'modified' }])
    expect(state.untracked).toEqual([{ path: 'src/new.txt', kind: 'untracked' }])
  })

  it('gives the files of a commit and the diff of one', async () => {
    const { top, g } = repo()
    const hash = g('rev-parse', 'HEAD').trim()
    expect((await git.commitFiles(top, hash)).files).toEqual([{ path: 'src/a.txt', kind: 'modified' }])
    const diff = await git.fileDiff(top, { hash, file: 'src/a.txt' })
    expect(diff.text).toContain('+beta')
    await expect(git.commitFiles(top, 'HEAD; rm -rf /')).rejects.toThrow('커밋')
    await expect(git.fileDiff(top, { file: '../outside' })).rejects.toThrow('경로')
  })

  it('diffs the work tree against HEAD and reads a file at HEAD', async () => {
    const { top } = repo()
    fs.writeFileSync(path.join(top, 'src', 'a.txt'), 'alpha\nbeta\ngamma\n')
    expect((await git.fileDiff(top, { file: 'src/a.txt' })).text).toContain('+gamma')
    const head = await git.fileAt(top, path.join(top, 'src', 'a.txt'))
    expect(head.content).toBe('alpha\nbeta\n')
    expect(head.time).toBeGreaterThan(0)
    expect(await git.fileAt(top, path.join(top, 'src', 'missing.txt'))).toBeNull()
  })

  it('parses renames in both outputs', () => {
    expect(git.parseNameStatus('R100\0old.txt\0new.txt\0M\0b.txt\0')).toEqual([{ path: 'new.txt', kind: 'renamed', from: 'old.txt' }, { path: 'b.txt', kind: 'modified' }])
    expect(git.parseStatus('R  new.txt\0old.txt\0').staged).toEqual([{ path: 'new.txt', kind: 'renamed', from: 'old.txt' }])
  })

  it('marks every unmerged pair as a conflict', () => {
    const parsed = git.parseStatus('AA both.txt\0DD gone.txt\0UD side.txt\0M  plain.txt\0')
    expect(parsed.staged.map(file => file.kind)).toEqual(['conflict', 'conflict', 'conflict', 'modified'])
    expect(parsed.changed.map(file => file.kind)).toEqual(['conflict', 'conflict', 'conflict'])
  })

  it('lists all revisions of one literal path across a rename and a deletion', async () => {
    const { top, g } = repo()
    const relative = 'src/[renamed] file.txt'
    const file = path.join(top, relative)
    g('mv', 'src/a.txt', relative)
    g('commit', '-q', '-m', 'rename')
    g('--literal-pathspecs', 'rm', relative)
    g('commit', '-q', '--allow-empty-message', '-m', '')
    const revisions = await git.fileHistory(top, file)
    expect(revisions.map(revision => [revision.subject, revision.deleted, path.basename(revision.path)])).toEqual([
      ['', true, '[renamed] file.txt'],
      ['rename', false, '[renamed] file.txt'],
      ['second', false, 'a.txt'],
      ['first', false, 'a.txt']
    ])
    const first = revisions[3]
    expect((await git.fileAt(top, first.path, first.hash)).content).toBe('alpha\n')
    expect(await git.fileHistory(top, path.join(top, 'untracked.txt'))).toEqual([])
  })
})

describe('git status line counts', { timeout: 30000 }, () => {
  it.each([
    ['## main', { hasHead: true, branch: 'main', upstream: null }],
    ['## main...origin/main [different]', { hasHead: true, branch: 'main', upstream: 'origin/main' }],
    ['## main...origin/main [gone]', { hasHead: true, branch: 'main', upstream: null }],
    ['## HEAD (no branch)', { hasHead: true, branch: null, upstream: null }],
    ['## No commits yet on main', { hasHead: false, branch: null, upstream: null }],
    ['## Initial commit on main', { hasHead: false, branch: null, upstream: null }]
  ])('reads the branch record %s without putting it in the file list', (header, expected) => {
    expect(git.parseStatusBranch(header)).toEqual(expected)
  })

  it('reads numstat with renames and binary files', () => {
    const out = ['3\t1\tsrc/a.txt', '-\t-\timg.png', '2\t0\t', 'old.txt', 'new.txt', ''].join('\0')
    expect(git.parseNumstat(out)).toEqual({ 'src/a.txt': [3, 1], 'img.png': [null, null], 'new.txt': [2, 0] })
  })

  it('gives lines added and removed against HEAD, the lines of new files, the branch and no upstream', async () => {
    const { top } = repo()
    fs.writeFileSync(path.join(top, 'src', 'a.txt'), 'alpha\nbeta\ngamma\ndelta\n')
    fs.writeFileSync(path.join(top, 'README.md'), '')
    fs.writeFileSync(path.join(top, 'new.txt'), 'x\ny\nz')
    fs.writeFileSync(path.join(top, 'blob.bin'), Buffer.from([1, 0, 2]))
    const { repo: status } = await git.status(top)
    expect(status.stats['src/a.txt']).toEqual([2, 0])
    expect(status.stats['README.md']).toEqual([0, 1])
    expect(status.stats['new.txt']).toEqual([3, 0])
    expect(status.stats['blob.bin']).toEqual([null, null])
    expect(status.branch).toBe('main')
    expect(status.upstream).toBeNull()
  })

  it('uses the index for staged counts with no HEAD and reads the first commit immediately', async () => {
    const { top, g } = repo({ unborn: true })
    fs.writeFileSync(path.join(top, 'staged.txt'), 'first\nsecond\n')
    g('add', 'staged.txt')
    fs.appendFileSync(path.join(top, 'staged.txt'), 'third\n')
    fs.writeFileSync(path.join(top, 'new.txt'), 'untracked\n')
    expect((await git.status(top)).repo).toEqual({
      top,
      branch: null,
      upstream: null,
      staged: [{ path: 'staged.txt', kind: 'added' }],
      changed: [{ path: 'staged.txt', kind: 'modified' }],
      untracked: [{ path: 'new.txt', kind: 'untracked' }],
      truncated: false,
      stats: { 'staged.txt': [2, 0], 'new.txt': [1, 0] }
    })
    expect((await readWorkspaceGit(top)).repo).toMatchObject({
      head: null, branch: 'main', worktrees: [{ path: top, branch: 'main' }], commits: []
    })
    g('commit', '-qm', 'first')
    const head = g('rev-parse', 'HEAD').trim()
    expect((await readWorkspaceGit(top)).repo).toMatchObject({ head, commits: [{ hash: head, subject: 'first' }] })
    expect((await git.status(top)).repo).toMatchObject({ branch: 'main', staged: [], stats: { 'staged.txt': [1, 0] } })
  })

  it('updates the upstream and detached HEAD immediately while the repository location is cached', async () => {
    const { top, g } = repo()
    g('config', 'remote.origin.fetch', '+refs/heads/*:refs/remotes/origin/*')
    g('config', 'branch.main.remote', 'origin')
    g('config', 'branch.main.merge', 'refs/heads/main')
    g('update-ref', 'refs/remotes/origin/main', 'HEAD')
    expect((await git.status(top)).repo).toMatchObject({ branch: 'main', upstream: 'origin/main' })
    g('update-ref', '-d', 'refs/remotes/origin/main')
    expect((await git.status(top)).repo).toMatchObject({ branch: 'main', upstream: null })
    g('checkout', '--detach', 'HEAD~1')
    const head = g('rev-parse', 'HEAD').trim()
    expect((await git.status(top)).repo).toMatchObject({ branch: null, upstream: null })
    expect((await readWorkspaceGit(top)).repo).toMatchObject({
      head, branch: null, worktrees: [{ path: top, branch: null }]
    })
    g('symbolic-ref', 'HEAD', 'refs/heads/unborn')
    g('config', 'branch.unborn.remote', '.')
    g('config', 'branch.unborn.merge', 'refs/heads/main')
    expect((await git.status(top)).repo).toMatchObject({ branch: null, upstream: 'main' })
  })

  it('detects a repository added to a folder previously under another repository', async () => {
    const { top } = repo()
    const nested = path.join(top, 'src')
    expect(await git.readRepoTop(nested)).toBe(top)
    execFileSync('git', ['init', '-q'], { cwd: nested })
    expect(await git.readRepoTop(nested)).toBe(nested)
    expect((await readWorkspaceGit(top)).repo.nestedRepositories).toEqual([nested])
  })

  it('clears the read root cache on lock and prevents pending reads from refilling it', async () => {
    const { top } = repo()
    const { clearSearches } = registerLocalProjectIpc({
      ipcMain: { handle() {} }, fromMainWindow: () => true, isLocked: () => false
    })
    const marker = vi.spyOn(fs.promises, 'lstat')
    try {
      await git.readRepoTop(top)
      await git.readRepoTop(top)
      expect(marker).toHaveBeenCalledWith(path.join(top, '.git'))
      marker.mockClear()

      clearSearches()
      const pending = git.readRepoTop(top)
      clearSearches()
      expect(await pending).toBe(top)
      expect(await git.readRepoTop(top)).toBe(top)
      expect(marker).not.toHaveBeenCalled()
    } finally {
      marker.mockRestore()
    }
  })

  it('returns an IPC error for a stalled scan and retries it on the next authorized request', async () => {
    const { top } = repo()
    const nested = path.join(top, 'src')
    execFileSync('git', ['init', '-q'], { cwd: nested })
    const handlers = new Map()
    const resolveRoot = vi.fn(async () => top)
    registerLocalProjectIpc({
      ipcMain: { handle: (name, callback) => handlers.set(name, callback) },
      fromMainWindow: () => true, isLocked: () => false, roots: { resolveRoot }
    })
    const readLog = () => handlers.get('workspace-git-log')({}, { folder: top })
    const originalTimeout = globalThis.setTimeout
    const timeout = vi.spyOn(globalThis, 'setTimeout').mockImplementationOnce((callback, delay) =>
      originalTimeout(callback, delay === 15000 ? 50 : delay))
    let finishRead
    const readdir = vi.spyOn(fs.promises, 'readdir').mockImplementationOnce(() => new Promise(resolve => { finishRead = resolve }))
    try {
      expect(await readLog()).toEqual({ success: false, error: '하위 Git 저장소를 찾는 시간이 초과되었습니다.' })
      expect(readdir).toHaveBeenCalledOnce()
    } finally {
      finishRead?.([])
      readdir.mockRestore()
      timeout.mockRestore()
    }
    expect(await readLog()).toMatchObject({ success: true, repo: { nestedRepositories: [nested] } })
    expect(resolveRoot).toHaveBeenCalledTimes(2)
  })
})
