import { describe, it, expect } from 'vitest'
import remoteFileModule from './remoteFile.js'
import fakeModule from './fakeSftp.testhelper.js'

const { inspectTarget, writeIfUnchanged, MAX_FILE_BYTES } = remoteFileModule
const { createFakeSftp } = fakeModule

const baseTree = () => ({
  '/srv': { type: 'dir' },
  '/srv/app': { type: 'dir' },
  '/srv/app/config.yml': { type: 'file', data: 'port: 8080\n', mode: 0o100640 },
  '/srv/app/latest': { type: 'link', target: '/srv/app/config.yml' },
  '/srv/app/broken': { type: 'link', target: '/srv/app/gone.txt' },
  '/srv/app/logs': { type: 'dir' },
  '/srv/app/socket': { type: 'special' },
  '/var': { type: 'dir' },
  '/var/www': { type: 'link', target: '/srv/app' }
})
const failsWith = async (promise, message) => {
  await expect(promise).rejects.toMatchObject({ userMessage: message })
}
/** Anything that changes a file: a write, a resize, or an open that creates or truncates */
const wrote = (sftp) => sftp.calls.some(([name, , flags]) => name === 'write' || name === 'fsetstat' || (name === 'open' && (flags === 'w' || flags === 'wx')))

describe('inspectTarget', () => {
  it('reads an existing text file with its mode', async () => {
    const sftp = createFakeSftp(baseTree())
    expect(await inspectTarget(sftp, '/srv/app/config.yml')).toEqual({
      requestedPath: '/srv/app/config.yml', path: '/srv/app/config.yml', exists: true, isSymlink: false, content: 'port: 8080\n', mode: 0o100640
    })
  })

  it('describes a file that does not exist yet', async () => {
    const sftp = createFakeSftp(baseTree())
    expect(await inspectTarget(sftp, '/srv/app/new.txt')).toEqual({
      requestedPath: '/srv/app/new.txt', path: '/srv/app/new.txt', exists: false, isSymlink: false, content: null, mode: null
    })
  })

  it('resolves a link to the real file', async () => {
    const sftp = createFakeSftp(baseTree())
    expect(await inspectTarget(sftp, '/srv/app/latest')).toMatchObject({ requestedPath: '/srv/app/latest', path: '/srv/app/config.yml', isSymlink: true, content: 'port: 8080\n' })
  })

  it('resolves a linked parent folder, also for a new file', async () => {
    const sftp = createFakeSftp(baseTree())
    expect(await inspectTarget(sftp, '/var/www/config.yml')).toMatchObject({ path: '/srv/app/config.yml', isSymlink: false, exists: true })
    expect(await inspectTarget(sftp, '/var/www/new.txt')).toMatchObject({ path: '/srv/app/new.txt', exists: false })
  })

  it.each([
    ['a missing parent folder', '/srv/nope/a.txt', '상위 폴더가 없습니다.'],
    ['a parent that is a file', '/srv/app/config.yml/a.txt', '상위 경로가 폴더가 아닙니다.'],
    ['a folder', '/srv/app/logs', '폴더에는 쓸 수 없습니다.'],
    ['a special file', '/srv/app/socket', '일반 파일이 아닙니다 (장치, 소켓 등).'],
    ['a broken link', '/srv/app/broken', '끊어진 심볼릭 링크입니다.']
  ])('refuses %s', async (label, target, message) => {
    await failsWith(inspectTarget(createFakeSftp(baseTree()), target), message)
  })

  it('refuses a file over the size limit without reading it', async () => {
    const sftp = createFakeSftp({ ...baseTree(), '/srv/app/big.log': { type: 'file', data: Buffer.alloc(MAX_FILE_BYTES + 1, 'a') } })
    await failsWith(inspectTarget(sftp, '/srv/app/big.log'), '파일이 너무 큽니다 (256KB까지).')
    expect(sftp.calls.some(([name]) => name === 'open' || name === 'read')).toBe(false)
  })

  it.each([
    ['a NUL byte', Buffer.from([0x61, 0x00, 0x62])],
    ['bytes that are not UTF-8', Buffer.from([0xff, 0xfe, 0x41])]
  ])('refuses a file with %s', async (label, data) => {
    const sftp = createFakeSftp({ ...baseTree(), '/srv/app/bin': { type: 'file', data } })
    await failsWith(inspectTarget(sftp, '/srv/app/bin'), '텍스트(UTF-8) 파일이 아닙니다.')
  })

  it('reports a file it may not read', async () => {
    const sftp = createFakeSftp(baseTree(), { failRead: ['/srv/app/config.yml'] })
    await failsWith(inspectTarget(sftp, '/srv/app/config.yml'), '파일을 읽을 권한이 없습니다.')
  })

  it('stops reading a file that never ends, whatever size it reports', async () => {
    const sftp = createFakeSftp({ ...baseTree(), '/srv/app/endless': { type: 'file', data: '', endless: true } })
    await failsWith(inspectTarget(sftp, '/srv/app/endless'), '파일이 너무 큽니다 (256KB까지).')
    const reads = sftp.calls.filter(([name]) => name === 'read').length
    expect(reads).toBeLessThanOrEqual(MAX_FILE_BYTES / (32 * 1024) + 1)
    expect(sftp.openHandles()).toBe(0)
  })

  it('closes the file it read, also when the content is refused', async () => {
    const sftp = createFakeSftp({ ...baseTree(), '/srv/app/bin': { type: 'file', data: Buffer.from([0x61, 0x00]) } })
    await inspectTarget(sftp, '/srv/app/config.yml')
    await inspectTarget(sftp, '/srv/app/bin').catch(() => {})
    expect(sftp.openHandles()).toBe(0)
  })

  describe('paths that must not be touched at all', () => {
    const refusePath = (target) => (target.startsWith('/proc/') ? '시스템 경로에는 쓸 수 없습니다.' : null)
    const tree = () => ({
      ...baseTree(),
      '/proc': { type: 'dir' },
      '/proc/sysrq-trigger': { type: 'file', data: '' },
      '/srv/app/innocent': { type: 'link', target: '/proc/sysrq-trigger' },
      '/srv/app/procdir': { type: 'link', target: '/proc' }
    })

    it.each([
      ['asked for directly', '/proc/sysrq-trigger'],
      ['reached through a link', '/srv/app/innocent'],
      ['reached through a linked folder', '/srv/app/procdir/sysrq-trigger'],
      ['a new file in such a folder', '/srv/app/procdir/new']
    ])('are refused when %s, before anything is opened', async (label, target) => {
      const sftp = createFakeSftp(tree())
      await failsWith(inspectTarget(sftp, target, { refusePath }), '시스템 경로에는 쓸 수 없습니다.')
      expect(sftp.calls.some(([name]) => name === 'open')).toBe(false)
    })

    it('leaves other paths alone', async () => {
      expect((await inspectTarget(createFakeSftp(tree()), '/srv/app/config.yml', { refusePath })).exists).toBe(true)
    })
  })

  it('keeps a byte order mark as part of the content', async () => {
    const sftp = createFakeSftp({ ...baseTree(), '/srv/app/bom.txt': { type: 'file', data: Buffer.from('﻿hi\n') } })
    expect((await inspectTarget(sftp, '/srv/app/bom.txt')).content).toBe('﻿hi\n')
  })
})

describe('writeIfUnchanged', () => {
  it('overwrites the existing file in place with exactly the new content', async () => {
    const sftp = createFakeSftp(baseTree())
    const seen = await inspectTarget(sftp, '/srv/app/config.yml')
    const result = await writeIfUnchanged(sftp, seen, 'port: 9090\n한글\n')
    expect(result).toEqual({ path: '/srv/app/config.yml', bytes: Buffer.byteLength('port: 9090\n한글\n'), created: false })
    expect(sftp.text('/srv/app/config.yml')).toBe('port: 9090\n한글\n')
    // Opened without truncating, compared, then written through the same handle
    expect(sftp.calls.filter(([name]) => name === 'open').map(([, target, flags]) => [target, flags])).toEqual([['/srv/app/config.yml', 'r'], ['/srv/app/config.yml', 'r+']])
    expect(sftp.tree.get('/srv/app/config.yml').mode).toBe(0o100640)
    expect(sftp.openHandles()).toBe(0)
  })

  it('creates a new file exclusively, readable by others but writable only by the owner', async () => {
    const sftp = createFakeSftp(baseTree())
    const seen = await inspectTarget(sftp, '/srv/app/new.txt')
    expect(await writeIfUnchanged(sftp, seen, 'hello\n')).toEqual({ path: '/srv/app/new.txt', bytes: 6, created: true })
    expect(sftp.calls.find(([name]) => name === 'open').slice(1)).toEqual(['/srv/app/new.txt', 'wx', { mode: 0o644 }])
    expect(sftp.text('/srv/app/new.txt')).toBe('hello\n')
  })

  it('writes through a link to the real file, leaving the link alone', async () => {
    const sftp = createFakeSftp(baseTree())
    await writeIfUnchanged(sftp, await inspectTarget(sftp, '/srv/app/latest'), 'x\n')
    expect(sftp.text('/srv/app/config.yml')).toBe('x\n')
    expect(sftp.tree.get('/srv/app/latest')).toEqual({ type: 'link', target: '/srv/app/config.yml' })
  })

  describe('refuses when the file is no longer what the user was shown', () => {
    const changed = '파일이 바뀌어 쓰지 않았습니다. 다시 요청하세요.'

    it('content changed', async () => {
      const sftp = createFakeSftp(baseTree())
      const seen = await inspectTarget(sftp, '/srv/app/config.yml')
      sftp.tree.set('/srv/app/config.yml', { type: 'file', data: 'port: 1\n' })
      await failsWith(writeIfUnchanged(sftp, seen, 'port: 9090\n'), changed)
      expect(wrote(sftp)).toBe(false)
      expect(sftp.text('/srv/app/config.yml')).toBe('port: 1\n')
    })

    it('a file appeared where a new one was to be created', async () => {
      const sftp = createFakeSftp(baseTree())
      const seen = await inspectTarget(sftp, '/srv/app/new.txt')
      sftp.tree.set('/srv/app/new.txt', { type: 'file', data: 'someone else\n' })
      await failsWith(writeIfUnchanged(sftp, seen, 'mine\n'), changed)
      expect(sftp.text('/srv/app/new.txt')).toBe('someone else\n')
    })

    it('the file disappeared', async () => {
      const sftp = createFakeSftp(baseTree())
      const seen = await inspectTarget(sftp, '/srv/app/config.yml')
      sftp.tree.delete('/srv/app/config.yml')
      await failsWith(writeIfUnchanged(sftp, seen, 'x\n'), changed)
      expect(wrote(sftp)).toBe(false)
    })

    it('the file became a link to another file', async () => {
      const sftp = createFakeSftp({ ...baseTree(), '/srv/app/other.txt': { type: 'file', data: 'port: 8080\n' } })
      const seen = await inspectTarget(sftp, '/srv/app/config.yml')
      sftp.tree.set('/srv/app/config.yml', { type: 'link', target: '/srv/app/other.txt' })
      await failsWith(writeIfUnchanged(sftp, seen, 'x\n'), changed)
      expect(sftp.text('/srv/app/other.txt')).toBe('port: 8080\n')
    })
  })

  it('leaves no tail when the new content is shorter', async () => {
    const sftp = createFakeSftp(baseTree())
    await writeIfUnchanged(sftp, await inspectTarget(sftp, '/srv/app/config.yml'), 'p\n')
    expect(sftp.text('/srv/app/config.yml')).toBe('p\n')
  })

  it('never follows a path that is swapped for a link just before the file is opened', async () => {
    let sftp
    const onBeforeOpen = (target, flags) => {
      if (flags === 'r+') sftp.tree.set('/srv/app/config.yml', { type: 'link', target: '/srv/app/other.txt' })
    }
    sftp = createFakeSftp({ ...baseTree(), '/srv/app/other.txt': { type: 'file', data: 'someone else\n' } }, { onBeforeOpen })
    const seen = await inspectTarget(sftp, '/srv/app/config.yml')
    await failsWith(writeIfUnchanged(sftp, seen, 'x\n'), '파일이 바뀌어 쓰지 않았습니다. 다시 요청하세요.')
    expect(sftp.text('/srv/app/other.txt')).toBe('someone else\n')
    expect(wrote(sftp)).toBe(false)
    expect(sftp.openHandles()).toBe(0)
  })

  it('tells the caller when the write starts, and only then', async () => {
    const sftp = createFakeSftp(baseTree())
    let starts = 0
    const onWriteStart = () => { starts++ }
    const seen = await inspectTarget(sftp, '/srv/app/config.yml')
    sftp.tree.set('/srv/app/config.yml', { type: 'file', data: 'port: 1\n' })
    await writeIfUnchanged(sftp, seen, 'x\n', { onWriteStart }).catch(() => {})
    expect(starts).toBe(0)
    await writeIfUnchanged(sftp, await inspectTarget(sftp, '/srv/app/config.yml'), 'x\n', { onWriteStart })
    await writeIfUnchanged(sftp, await inspectTarget(sftp, '/srv/app/fresh.txt'), 'y\n', { onWriteStart })
    expect(starts).toBe(2)
  })

  it('creates a new file with the mode it is given', async () => {
    const sftp = createFakeSftp(baseTree())
    await writeIfUnchanged(sftp, await inspectTarget(sftp, '/srv/app/secret.key'), 'k\n', { newFileMode: 0o600 })
    expect(sftp.calls.find(([name, , flags]) => name === 'open' && flags === 'wx').slice(1)).toEqual(['/srv/app/secret.key', 'wx', { mode: 0o600 }])
  })

  it('treats a failure to cut the file to its new length as a failed write', async () => {
    const sftp = createFakeSftp(baseTree(), { failFsetstatCalls: [1] })
    const seen = await inspectTarget(sftp, '/srv/app/config.yml')
    await failsWith(writeIfUnchanged(sftp, seen, 'p\n'), '쓰는 중 오류가 발생해 이전 내용으로 되돌렸습니다.')
    expect(sftp.text('/srv/app/config.yml')).toBe('port: 8080\n')
  })

  it('treats a failing close as a failed write', async () => {
    // close 1 belongs to the inspection, close 2 to the write
    const sftp = createFakeSftp(baseTree(), { failCloseCalls: [2] })
    const seen = await inspectTarget(sftp, '/srv/app/config.yml')
    await expect(writeIfUnchanged(sftp, seen, 'port: 9090\n')).rejects.toMatchObject({ userMessage: expect.stringContaining('쓰는 중 오류가 발생') })
  })

  it('does not overwrite a file that appears at the very last moment', async () => {
    let sftp
    const onBeforeOpen = (target, flags) => { if (flags === 'wx') sftp.tree.set(target, { type: 'file', data: 'raced\n' }) }
    sftp = createFakeSftp(baseTree(), { onBeforeOpen })
    const seen = await inspectTarget(sftp, '/srv/app/new.txt')
    await failsWith(writeIfUnchanged(sftp, seen, 'mine\n'), '파일을 만들 수 없습니다.')
    expect(sftp.text('/srv/app/new.txt')).toBe('raced\n')
    expect(sftp.calls.some(([name]) => name === 'unlink')).toBe(false)
  })

  it('does not write when cancelled before the write starts', async () => {
    const sftp = createFakeSftp(baseTree())
    const seen = await inspectTarget(sftp, '/srv/app/config.yml')
    const controller = new AbortController()
    controller.abort()
    await failsWith(writeIfUnchanged(sftp, seen, 'x\n', { signal: controller.signal }), '요청이 취소되어 쓰지 않았습니다.')
    expect(wrote(sftp)).toBe(false)
  })

  it('refuses new content over the size limit', async () => {
    const sftp = createFakeSftp(baseTree())
    const seen = await inspectTarget(sftp, '/srv/app/config.yml')
    await failsWith(writeIfUnchanged(sftp, seen, '가'.repeat(MAX_FILE_BYTES / 3 + 1)), '내용이 너무 큽니다 (256KB까지).')
    expect(wrote(sftp)).toBe(false)
  })

  it('puts the previous content back when writing fails halfway', async () => {
    const sftp = createFakeSftp(baseTree(), { failWriteCalls: [1] })
    const seen = await inspectTarget(sftp, '/srv/app/config.yml')
    await failsWith(writeIfUnchanged(sftp, seen, 'port: 9090\n'), '쓰는 중 오류가 발생해 이전 내용으로 되돌렸습니다.')
    expect(sftp.text('/srv/app/config.yml')).toBe('port: 8080\n')
  })

  it('says so when the previous content could not be put back either', async () => {
    const sftp = createFakeSftp(baseTree(), { failWriteCalls: [1, 2] })
    const seen = await inspectTarget(sftp, '/srv/app/config.yml')
    await failsWith(writeIfUnchanged(sftp, seen, 'port: 9090\n'), '쓰는 중 오류가 발생했고 이전 내용으로 되돌리지 못했습니다. 파일을 확인하세요.')
  })

  it('removes a new file that could not be written completely', async () => {
    const sftp = createFakeSftp(baseTree(), { failWriteCalls: [1] })
    const seen = await inspectTarget(sftp, '/srv/app/new.txt')
    await failsWith(writeIfUnchanged(sftp, seen, 'hello\n'), '파일을 쓰는 중 오류가 발생했습니다.')
    expect(sftp.tree.has('/srv/app/new.txt')).toBe(false)
  })

  it('can empty a file', async () => {
    const sftp = createFakeSftp(baseTree())
    const result = await writeIfUnchanged(sftp, await inspectTarget(sftp, '/srv/app/config.yml'), '')
    expect(result.bytes).toBe(0)
    expect(sftp.text('/srv/app/config.yml')).toBe('')
  })
})
