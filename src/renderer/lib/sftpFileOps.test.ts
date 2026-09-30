import { describe, it, expect, vi } from 'vitest'
import { joinChildPath, nextFolderName, parentPath, moveEntries } from './sftpFileOps'

describe('joinChildPath', () => {
  it('joins Windows local paths with a backslash', () => {
    expect(joinChildPath('C:\\', 'a', 'local')).toBe('C:\\a')
    expect(joinChildPath('C:\\Users', 'a', 'local')).toBe('C:\\Users\\a')
  })

  it('joins remote paths with a slash', () => {
    expect(joinChildPath('/', 'a', 'remote')).toBe('/a')
    expect(joinChildPath('/home/user', 'a', 'remote')).toBe('/home/user/a')
    expect(joinChildPath('/home/user/', 'a', 'remote')).toBe('/home/user/a')
  })
})

describe('nextFolderName', () => {
  it('uses the base name when free', () => {
    expect(nextFolderName(['a'])).toBe('새 폴더')
  })

  it('numbers the name like Explorer when taken', () => {
    expect(nextFolderName(['새 폴더'])).toBe('새 폴더 (2)')
    expect(nextFolderName(['새 폴더', '새 폴더 (2)'])).toBe('새 폴더 (3)')
  })
})

describe('parentPath', () => {
  it('goes up one level on remote paths and stops at the root', () => {
    expect(parentPath('/home/user', 'remote')).toBe('/home')
    expect(parentPath('/home', 'remote')).toBe('/')
    expect(parentPath('/home/user/', 'remote')).toBe('/home')
    expect(parentPath('/', 'remote')).toBeNull()
  })

  it('goes up on Windows local paths and stays on the same drive', () => {
    expect(parentPath('C:\\Users\\me', 'local')).toBe('C:\\Users')
    expect(parentPath('C:\\Users\\me\\', 'local')).toBe('C:\\Users')
    expect(parentPath('D:\\work', 'local')).toBe('D:\\')
    expect(parentPath('D:\\', 'local')).toBeNull()
  })
})

describe('moveEntries', () => {
  const deps = (overrides: Partial<Record<'confirm' | 'move', unknown>> = {}) => ({
    confirm: vi.fn((_message: string) => true),
    move: vi.fn(async (_sourcePath: string, _targetDir: string) => {}),
    ...overrides
  }) as { confirm: ReturnType<typeof vi.fn<(message: string) => boolean>>, move: ReturnType<typeof vi.fn<(sourcePath: string, targetDir: string) => Promise<void>>> }

  it('asks first and moves each entry into the target folder', async () => {
    const d = deps()
    const moved = await moveEntries({ side: 'remote', dirPath: '/var/www', names: ['a.txt', 'img'], targetDir: '/var/www/old' }, d)
    expect(moved).toEqual({ moved: ['a.txt', 'img'], failed: 0 })
    expect(d.confirm).toHaveBeenCalledTimes(1)
    expect(String(d.confirm.mock.calls[0][0])).toContain('/var/www/old')
    expect(d.move.mock.calls).toEqual([['/var/www/a.txt', '/var/www/old'], ['/var/www/img', '/var/www/old']])
  })

  it('moves nothing when the confirmation is declined', async () => {
    const d = deps({ confirm: vi.fn(() => false) })
    expect(await moveEntries({ side: 'remote', dirPath: '/a', names: ['x'], targetDir: '/a/b' }, d)).toEqual({ moved: [], failed: 0 })
    expect(d.move).not.toHaveBeenCalled()
  })

  it('skips the target folder itself and entries already in the target', async () => {
    const d = deps()
    const moved = await moveEntries({ side: 'remote', dirPath: '/a', names: ['b', 'x'], targetDir: '/a/b' }, d)
    expect(moved).toEqual({ moved: ['x'], failed: 0 })
    expect(d.move.mock.calls).toEqual([['/a/x', '/a/b']])
    const none = deps()
    expect(await moveEntries({ side: 'remote', dirPath: '/a', names: ['x'], targetDir: '/a' }, none)).toEqual({ moved: [], failed: 0 })
    expect(none.confirm).not.toHaveBeenCalled()
  })

  it('keeps going after a failure and counts only the moved entries', async () => {
    const d = deps({ move: vi.fn(async (src: string) => { if (src.endsWith('dup')) throw new Error('Failure') }) })
    const moved = await moveEntries({ side: 'remote', dirPath: '/a', names: ['dup', 'ok'], targetDir: '/a/b' }, d)
    expect(moved).toEqual({ moved: ['ok'], failed: 1 })
    expect(d.move).toHaveBeenCalledTimes(2)
  })

  it('builds Windows local source paths', async () => {
    const d = deps()
    await moveEntries({ side: 'local', dirPath: 'C:\\work', names: ['a.txt'], targetDir: 'C:\\work\\sub' }, d)
    expect(d.move.mock.calls).toEqual([['C:\\work\\a.txt', 'C:\\work\\sub']])
  })
})
