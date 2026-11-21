import { afterEach, describe, expect, it } from 'vitest'
const fs = require('fs')
const os = require('os')
const path = require('path')
const { execFileSync } = require('child_process')
const { createLocalRoots } = require('./roots.js')
const localRead = require('./localRead.js')
const git = require('./git.js')

let temp
afterEach(() => { if (temp) fs.rmSync(temp, { recursive: true, force: true }); temp = undefined })

function repo() {
  temp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ezshell-localfiles-')))
  const top = path.join(temp, 'app')
  fs.mkdirSync(path.join(top, 'src'), { recursive: true })
  const g = (...args) => execFileSync('git', args, { cwd: top, encoding: 'utf8' })
  g('init', '-q', '-b', 'main')
  g('config', 'user.email', 't@example.com')
  g('config', 'user.name', 'T')
  fs.writeFileSync(path.join(top, 'README.md'), 'one\n')
  fs.writeFileSync(path.join(top, 'src', 'a.txt'), 'alpha\n')
  g('add', '.')
  g('commit', '-q', '-m', 'first')
  fs.writeFileSync(path.join(top, 'src', 'a.txt'), 'alpha\nbeta\n')
  g('commit', '-q', '-am', 'second')
  return { top, g }
}

describe('roots', () => {
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

describe('git', () => {
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

describe('git status line counts', () => {
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
})
