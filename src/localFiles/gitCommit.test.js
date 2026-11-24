import { afterEach, describe, expect, it } from 'vitest'
const fs = require('fs')
const os = require('os')
const path = require('path')
const { execFileSync } = require('child_process')
const { commitSelected, requireCommitMessage } = require('./gitCommit.js')

let temp
// A git process still closing can hold the folder on Windows for a moment: retry the removal
afterEach(() => { if (temp) fs.rmSync(temp, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); temp = undefined })

function repo() {
  temp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ezshell-gitcommit-')))
  const top = path.join(temp, 'app')
  fs.mkdirSync(path.join(top, 'src'), { recursive: true })
  const g = (...args) => execFileSync('git', args, { cwd: top, encoding: 'utf8' })
  g('init', '-q', '-b', 'main')
  g('config', 'user.email', 't@example.com')
  g('config', 'user.name', 'T')
  fs.writeFileSync(path.join(top, 'README.md'), 'one\n')
  fs.writeFileSync(path.join(top, 'src', 'a.txt'), 'alpha\n')
  fs.writeFileSync(path.join(top, 'src', 'b.txt'), 'bravo\n')
  fs.writeFileSync(path.join(top, '.gitignore'), 'secret.env\n')
  g('add', '.')
  g('commit', '-q', '-m', 'first')
  const write = (file, text) => fs.writeFileSync(path.join(top, file), text)
  // Files in the last commit, and the short status of the work tree
  const committed = () => g('show', '--no-renames', '--name-status', '--format=', 'HEAD').trim().split('\n').filter(Boolean).map(line => line.replace(/\t/, ' '))
  const status = () => g('status', '--porcelain=v1', '--untracked-files=all').split('\n').filter(Boolean)
  const subject = () => g('log', '-1', '--format=%s').trim()
  return { top, g, write, committed, status, subject }
}

function hook(top, body, name = 'pre-commit') {
  const file = path.join(top, '.git', 'hooks', name)
  fs.writeFileSync(file, `#!/bin/sh\n${body}\n`)
  fs.chmodSync(file, 0o755)
}

describe('requireCommitMessage', () => {
  it('keeps the text, with CR line ends turned into LF', () => {
    expect(requireCommitMessage('  fix: 줄바꿈\r\n\r\n본문 "따옴표" \\경로\\  ')).toBe('fix: 줄바꿈\n\n본문 "따옴표" \\경로\\')
    expect(requireCommitMessage('a\rb\tc')).toBe('a\nb\tc')
  })

  it('refuses an empty, long or control-character message', () => {
    for (const bad of ['', '   \n ', 'x'.repeat(5001), 'a\u0000b', 'a\u001bb', 'a\u007fb', undefined, 42]) {
      expect(() => requireCommitMessage(bad)).toThrow()
    }
    expect(requireCommitMessage('x'.repeat(5000))).toHaveLength(5000)
  })
})

// Real git processes (and hooks): under a full parallel run they took more than vitest's default 5 seconds
describe('commitSelected', { timeout: 30000 }, () => {
  it('commits only the chosen files; a staged file left out stays staged', async () => {
    const { top, g, write, committed, status, subject } = repo()
    write('src/a.txt', 'alpha 2\n')
    write('src/b.txt', 'bravo 2\n')
    write('README.md', 'two\n')
    g('add', 'src/b.txt', 'README.md')
    const result = await commitSelected(top, { files: ['src/a.txt', 'README.md'], message: 'pick two' })
    expect(result.count).toBe(2)
    expect(result.hash).toMatch(/^[0-9a-f]{40}$/)
    expect(result.shortHash).toBe(result.hash.slice(0, result.shortHash.length))
    expect(subject()).toBe('pick two')
    expect(committed().sort()).toEqual(['M README.md', 'M src/a.txt'])
    expect(status()).toEqual(['M  src/b.txt'])
  })

  it('adds a chosen new file and leaves the other new file untracked', async () => {
    const { top, write, committed, status } = repo()
    write('src/new.txt', 'n\n')
    write('src/other.txt', 'o\n')
    await commitSelected(path.join(top, 'src'), { files: ['src/new.txt'], message: 'new file' })
    expect(committed()).toEqual(['A src/new.txt'])
    expect(status()).toEqual(['?? src/other.txt'])
  })

  it('commits a deletion, and a staged rename with the old path gone', async () => {
    const { top, g, committed, status } = repo()
    fs.rmSync(path.join(top, 'README.md'))
    g('mv', 'src/a.txt', 'src/renamed.txt')
    await commitSelected(top, { files: ['README.md', 'src/renamed.txt'], message: 'move' })
    expect(committed().sort()).toEqual(['A src/renamed.txt', 'D README.md', 'D src/a.txt'])
    expect(status()).toEqual([])
  })

  it('commits nothing when a path is not in the changed list', async () => {
    const { top, g, write, status } = repo()
    write('src/a.txt', 'alpha 2\n')
    write('secret.env', 'TOKEN=1\n')
    const head = g('rev-parse', 'HEAD').trim()
    for (const files of [['src/a.txt', 'src/b.txt'], ['src/a.txt', 'secret.env'], ['missing.txt']]) {
      await expect(commitSelected(top, { files, message: 'no' })).rejects.toThrow('목록')
    }
    expect(g('rev-parse', 'HEAD').trim()).toBe(head)
    expect(status()).toEqual([' M src/a.txt'])
  })

  it('refuses paths outside the repository and bad lists', async () => {
    const { top } = repo()
    for (const files of [['../outside.txt'], ['/etc/passwd'], ['C:/Windows/win.ini'], ['src/a\u0000.txt'], [':(glob)*'], [], 'src/a.txt', ['src/a.txt', 'src/a.txt'], [42]]) {
      await expect(commitSelected(top, { files, message: 'no' })).rejects.toThrow()
    }
  })

  it('reads glob characters in a name literally', async () => {
    const { top, write, committed, status } = repo()
    write('src/[ab].txt', 'x\n')
    write('src/a.txt', 'alpha 2\n')
    await commitSelected(top, { files: ['src/[ab].txt'], message: 'literal' })
    expect(committed()).toEqual(['A src/[ab].txt'])
    expect(status()).toEqual([' M src/a.txt'])
  })

  it('records the message as written: quotes, backslashes, Korean and several lines', async () => {
    const { top, g, write } = repo()
    write('src/a.txt', 'alpha 2\n')
    const message = 'feat: "변경" 탭 \\ C:\\path\n\n- 한 줄\n- 두 줄 \'작은따옴표\' $HOME `cmd`'
    await commitSelected(top, { files: ['src/a.txt'], message })
    expect(g('log', '-1', '--format=%B').replace(/\n+$/, '')).toBe(message)
  })

  it('leaves no commit and un-adds the new files when a hook refuses', async () => {
    const { top, g, write, status } = repo()
    hook(top, 'printf "\\033[31mlint failed: src/new.txt\\033[0m\\n" >&2\nexit 1')
    write('src/new.txt', 'n\n')
    write('src/a.txt', 'alpha 2\n')
    const head = g('rev-parse', 'HEAD').trim()
    const refused = await commitSelected(top, { files: ['src/new.txt', 'src/a.txt'], message: 'hooked' }).catch(error => error)
    expect(refused.message).toContain('lint failed: src/new.txt')
    // Colour codes are taken out of the text the panel shows
    expect(refused.message).not.toMatch(/\u001b/)
    expect(g('rev-parse', 'HEAD').trim()).toBe(head)
    expect(status().sort()).toEqual([' M src/a.txt', '?? src/new.txt'])
    expect(fs.existsSync(path.join(top, 'src', 'new.txt'))).toBe(true)
  })

  it('keeps a commit made before a post-commit hook hung, and says so', async () => {
    const { top, g, write, status, subject } = repo()
    hook(top, 'sleep 6', 'post-commit')
    write('src/new.txt', 'n\n')
    const result = await commitSelected(top, { files: ['src/new.txt'], message: 'landed' }, { commitTimeoutMs: 2000 })
    expect(result.warning).toContain('훅')
    expect(result.hash).toBe(g('rev-parse', 'HEAD').trim())
    expect(subject()).toBe('landed')
    // The new file stays committed (it is not taken out of the index again)
    expect(status()).toEqual([])
  }, 20000)

  it('refuses a repository nested in this one', async () => {
    const { top, g } = repo()
    fs.mkdirSync(path.join(top, 'vendor', 'lib'), { recursive: true })
    execFileSync('git', ['init', '-q'], { cwd: path.join(top, 'vendor', 'lib') })
    fs.writeFileSync(path.join(top, 'vendor', 'lib', 'x.txt'), 'x\n')
    expect(g('status', '--porcelain', '--untracked-files=all')).toContain('?? vendor/lib/')
    await expect(commitSelected(top, { files: ['vendor/lib/'], message: 'nested' })).rejects.toThrow('다른 저장소')
  })

  it('runs one commit at a time in a repository', async () => {
    const { top, write } = repo()
    hook(top, 'sleep 1')
    write('src/a.txt', 'alpha 2\n')
    write('src/b.txt', 'bravo 2\n')
    const results = await Promise.allSettled([
      commitSelected(top, { files: ['src/a.txt'], message: 'one' }),
      commitSelected(top, { files: ['src/b.txt'], message: 'two' })
    ])
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1)
    expect(results.find(result => result.status === 'rejected').reason.message).toContain('커밋하는 중')
    // The lock is let go afterwards
    write('src/b.txt', 'bravo 3\n')
    write('src/a.txt', 'alpha 3\n')
    await expect(commitSelected(top, { files: ['src/a.txt', 'src/b.txt'], message: 'later' })).resolves.toMatchObject({ count: 2 })
  }, 20000)

  it('refuses a file with a merge conflict', async () => {
    const { top, g, write } = repo()
    g('checkout', '-q', '-b', 'side')
    write('src/a.txt', 'side\n')
    g('commit', '-q', '-am', 'side')
    g('checkout', '-q', 'main')
    write('src/a.txt', 'main\n')
    g('commit', '-q', '-am', 'main')
    expect(() => g('merge', '-q', 'side')).toThrow()
    await expect(commitSelected(top, { files: ['src/a.txt'], message: 'merge' })).rejects.toThrow('충돌')
  })
})
