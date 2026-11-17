import { describe, it, expect } from 'vitest'
import path from 'node:path'
import { downloadDirectory, isSafeEntryName, MAX_DEPTH } from './sftpDownloadDir.js'

const entry = (filename, kind) => ({
  filename,
  attrs: { isDirectory: () => kind === 'dir', isFile: () => kind === 'file', isSymbolicLink: () => kind === 'link' }
})

/** A fake server: remote folder path -> entries */
function setup(tree, platform = 'win32') {
  const made = []
  const queued = []
  const deps = {
    platform,
    readdir: async dir => {
      if (!(dir in tree)) throw new Error(`no such folder: ${dir}`)
      return tree[dir]
    },
    mkdir: async dir => { made.push(dir) },
    queueDownload: transfer => { queued.push(transfer) }
  }
  return { deps, made, queued }
}

describe('isSafeEntryName', () => {
  it('takes ordinary names', () => {
    for (const name of ['app.log', '한글 폴더', '.env', 'a b (1).txt', 'archive.tar.gz']) {
      expect(isSafeEntryName(name, 'win32')).toBe(true)
      expect(isSafeEntryName(name, 'linux')).toBe(true)
    }
  })

  it('refuses names that would step out of the target folder, on every system', () => {
    for (const name of ['..', '.', '', '../evil', 'a/b', 'a\\b', 'x\u0000y', 'line\nbreak', 'n'.repeat(256)]) {
      expect(isSafeEntryName(name, 'win32')).toBe(false)
      expect(isSafeEntryName(name, 'linux')).toBe(false)
    }
    expect(isSafeEntryName(undefined, 'win32')).toBe(false)
  })

  it('refuses names Windows reads as something else', () => {
    for (const name of ['C:evil', 'file.txt:stream', 'NUL', 'con.txt', 'COM1', 'trailing.', 'trailing ', 'a*b', 'what?', '"q"', 'a|b', '<x>']) {
      expect(isSafeEntryName(name, 'win32')).toBe(false)
    }
    // Fine on other systems
    expect(isSafeEntryName('file.txt:stream', 'linux')).toBe(true)
    expect(isSafeEntryName('NUL', 'darwin')).toBe(true)
  })
})

describe('downloadDirectory', () => {
  it('makes the folders and queues every file under them', async () => {
    const { deps, made, queued } = setup({
      '/srv/app': [entry('a.txt', 'file'), entry('conf', 'dir'), entry('.', 'dir'), entry('..', 'dir')],
      '/srv/app/conf': [entry('app.yaml', 'file')]
    })
    const result = await downloadDirectory(deps, '/srv/app', path.join('D:', 'work', 'app'))
    expect(result).toEqual({ files: 2, folders: 2, skipped: [] })
    expect(made).toEqual([path.join('D:', 'work', 'app'), path.join('D:', 'work', 'app', 'conf')])
    expect(queued).toEqual([
      { remotePath: '/srv/app/a.txt', localPath: path.join('D:', 'work', 'app', 'a.txt') },
      { remotePath: '/srv/app/conf/app.yaml', localPath: path.join('D:', 'work', 'app', 'conf', 'app.yaml') }
    ])
  })

  it('leaves out links, special files and names this PC cannot take, and says which', async () => {
    const { deps, queued } = setup({
      '/d': [entry('ok.txt', 'file'), entry('link', 'link'), entry('sock', 'other'), entry('..\\..\\evil.txt', 'file'), entry('C:x', 'file')]
    })
    const result = await downloadDirectory(deps, '/d', path.join('D:', 't'))
    expect(queued.map(item => item.remotePath)).toEqual(['/d/ok.txt'])
    expect(result.skipped).toEqual(['/d/link', '/d/sock', '/d/..\\..\\evil.txt', '/d/C:x'])
    // Nothing queued lands outside the target folder
    for (const item of queued) expect(item.localPath.startsWith(path.join('D:', 't') + path.sep)).toBe(true)
  })

  it('handles the root folder without doubling the slash', async () => {
    const { deps, queued } = setup({ '/': [entry('etc', 'dir')], '/etc': [entry('hosts', 'file')] }, 'linux')
    await downloadDirectory(deps, '/', '/tmp/root')
    expect(queued[0].remotePath).toBe('/etc/hosts')
  })

  it('stops on a tree deeper than the limit', async () => {
    const tree = {}
    let dir = '/deep'
    for (let i = 0; i <= MAX_DEPTH + 1; i++) {
      tree[dir] = [entry('d', 'dir')]
      dir += '/d'
    }
    const { deps } = setup(tree)
    await expect(downloadDirectory(deps, '/deep', path.join('D:', 't'))).rejects.toThrow('너무 깊습니다')
  })

  it('passes on a folder that cannot be read', async () => {
    const { deps } = setup({ '/a': [entry('gone', 'dir')] })
    await expect(downloadDirectory(deps, '/a', path.join('D:', 't'))).rejects.toThrow('no such folder')
  })
})
