import { describe, it, expect, vi } from 'vitest'
import nodePath from 'path'
import localPathModule from './localPath.js'

const { resolveLocalPath, isInside, MESSAGES } = localPathModule
const win = nodePath.win32
const posix = nodePath.posix

/**
 * A Windows-shaped file system for realpath: `links` maps a path to what it really is,
 * `missing` lists paths that do not exist.
 */
function fakeRealpath({ links = {}, missing = [] } = {}) {
  const lower = (value) => value.toLowerCase()
  const gone = missing.map(lower)
  return vi.fn(async (target) => {
    if (gone.includes(lower(target))) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
    const hit = Object.keys(links).find(link => lower(target) === lower(link) || lower(target).startsWith(`${lower(link)}\\`))
    return hit ? links[hit] + target.slice(hit.length) : target
  })
}

const resolve = (input, { roots = ['C:\\work'], userDataDir = 'C:\\Users\\me\\AppData\\Roaming\\my-ssh-client', realpath = fakeRealpath() } = {}) =>
  resolveLocalPath(input, { roots, userDataDir, realpath, pathApi: win }).then(result => ({ result, realpath }))

describe('resolveLocalPath: only registered folders', () => {
  it('accepts a file inside a registered folder', async () => {
    const { result } = await resolve('C:\\work\\dist\\app.jar')
    expect(result).toEqual({ ok: true, path: 'C:\\work\\dist\\app.jar', requestedPath: 'C:\\work\\dist\\app.jar' })
  })

  it('accepts a file that does not exist yet when its folder does', async () => {
    const { result } = await resolve('C:\\work\\new.log', { realpath: fakeRealpath({ missing: ['C:\\work\\new.log'] }) })
    expect(result).toEqual({ ok: true, path: 'C:\\work\\new.log', requestedPath: 'C:\\work\\new.log' })
  })

  it('refuses everything while no folder is registered, without touching the file system', async () => {
    const { result, realpath } = await resolve('C:\\work\\a.txt', { roots: [] })
    expect(result).toEqual({ ok: false, error: MESSAGES.noRoots })
    expect(realpath).not.toHaveBeenCalled()
  })

  it.each([
    ['another folder', 'C:\\Users\\me\\.ssh\\id_rsa'],
    ['a neighbour whose name starts the same', 'C:\\work2\\a.txt'],
    ['climbing out with ..', 'C:\\work\\..\\Users\\me\\a.txt'],
    ['another drive', 'D:\\work\\a.txt'],
    ['the registered folder itself', 'C:\\work']
  ])('refuses %s without touching the file system', async (label, input) => {
    const { result, realpath } = await resolve(input)
    expect(result).toEqual({ ok: false, error: MESSAGES.outside })
    expect(realpath).not.toHaveBeenCalled()
  })

  it('treats drive letter and folder case as the same folder', async () => {
    const { result } = await resolve('c:\\WORK\\a.txt')
    expect(result.ok).toBe(true)
  })

  it('answers the same for a path outside whether or not it exists', async () => {
    const existing = await resolve('C:\\secret\\real.txt')
    const absent = await resolve('C:\\secret\\nothing.txt', { realpath: fakeRealpath({ missing: ['C:\\secret\\nothing.txt'] }) })
    expect(existing.result).toEqual(absent.result)
  })

  it('refuses a junction inside the folder that leads outside', async () => {
    const { result } = await resolve('C:\\work\\link\\id_rsa', { realpath: fakeRealpath({ links: { 'C:\\work\\link': 'C:\\Users\\me\\.ssh' } }) })
    expect(result).toEqual({ ok: false, error: MESSAGES.unreachable })
  })

  it('refuses a file link inside the folder that points outside', async () => {
    const { result } = await resolve('C:\\work\\notes.txt', { realpath: fakeRealpath({ links: { 'C:\\work\\notes.txt': 'C:\\Users\\me\\.ssh\\id_rsa' } }) })
    expect(result).toEqual({ ok: false, error: MESSAGES.unreachable })
  })

  // Review M-3: a junction inside the folder must not tell whether the place it points at exists
  it('answers the same through a junction whether its target folder exists or not', async () => {
    const links = { 'C:\\work\\j': 'C:\\Users\\other\\secret' }
    const existing = await resolve('C:\\work\\j\\a.txt', { realpath: fakeRealpath({ links }) })
    const absent = await resolve('C:\\work\\j\\a.txt', { realpath: fakeRealpath({ links, missing: ['C:\\work\\j'] }) })
    expect(existing.result).toEqual({ ok: false, error: MESSAGES.unreachable })
    expect(absent.result).toEqual(existing.result)
  })

  it('answers the same for a file link whether its target exists or not', async () => {
    const lstat = async () => ({})
    const dangling = await resolveLocalPath('C:\\work\\notes.txt', {
      roots: ['C:\\work'], realpath: fakeRealpath({ missing: ['C:\\work\\notes.txt'] }), lstat, pathApi: win
    })
    expect(dangling).toEqual({ ok: false, error: MESSAGES.unreachable })
  })

  it('reports the real path when a link stays inside a registered folder', async () => {
    const { result } = await resolve('C:\\work\\cur\\a.txt', { realpath: fakeRealpath({ links: { 'C:\\work\\cur': 'C:\\work\\v2' } }) })
    expect(result).toEqual({ ok: true, path: 'C:\\work\\v2\\a.txt', requestedPath: 'C:\\work\\cur\\a.txt' })
  })

  // Review H-1: a registered folder is stored by its real path. If that path later leads somewhere
  // else, somebody replaced the folder with a junction, and what it reaches was never registered.
  it('ignores a registered folder that has been replaced by a junction', async () => {
    const realpath = fakeRealpath({ links: { 'C:\\work': 'C:\\Users\\me' } })
    const { result } = await resolve('C:\\work\\.ssh\\id_ed25519', { realpath })
    expect(result).toEqual({ ok: false, error: MESSAGES.unreachable })
  })

  it('still accepts a registered folder whose stored path differs only in case', async () => {
    const { result } = await resolve('C:\\work\\a.txt', { roots: ['c:\\WORK'] })
    expect(result.ok).toBe(true)
  })

  it('ignores a registered folder that no longer exists', async () => {
    const { result } = await resolve('C:\\gone\\a.txt', { roots: ['C:\\gone'], realpath: fakeRealpath({ missing: ['C:\\gone'] }) })
    expect(result).toEqual({ ok: false, error: MESSAGES.unreachable })
  })

  it('refuses the app data folder even when a registered folder reaches it', async () => {
    const { result } = await resolve('C:\\work\\data\\sessions.json', {
      realpath: fakeRealpath({ links: { 'C:\\work\\data': 'C:\\Users\\me\\AppData\\Roaming\\my-ssh-client' } }),
      roots: ['C:\\work', 'C:\\Users\\me\\AppData\\Roaming']
    })
    expect(result).toEqual({ ok: false, error: MESSAGES.appData })
  })

  it('says so when the parent folder is missing (inside a registered folder)', async () => {
    const { result } = await resolve('C:\\work\\nope\\a.txt', { realpath: fakeRealpath({ missing: ['C:\\work\\nope'] }) })
    expect(result).toEqual({ ok: false, error: MESSAGES.unreachable })
  })
})

describe('resolveLocalPath: path forms that are refused', () => {
  it.each([
    ['empty', '', MESSAGES.empty],
    ['not a string', 42, MESSAGES.empty],
    ['relative', 'work\\a.txt', MESSAGES.notAbsolute],
    ['drive-relative', 'C:a.txt', MESSAGES.notAbsolute],
    ['UNC', '\\\\server\\share\\a.txt', MESSAGES.notAbsolute],
    ['device namespace', '\\\\?\\C:\\work\\a.txt', MESSAGES.notAbsolute],
    ['device path', '\\\\.\\C:\\work\\a.txt', MESSAGES.notAbsolute],
    ['rooted without a drive', '\\work\\a.txt', MESSAGES.notAbsolute],
    ['alternate data stream', 'C:\\work\\a.txt:hidden', MESSAGES.badName],
    ['reserved name', 'C:\\work\\NUL', MESSAGES.badName],
    ['reserved name with extension', 'C:\\work\\con.txt', MESSAGES.badName],
    ['console input device', 'C:\\work\\CONIN$', MESSAGES.badName],
    ['port name written with a superscript digit', 'C:\\work\\COM\u00b9', MESSAGES.badName],
    ['name ending with a dot', 'C:\\work\\a.txt.', MESSAGES.badName],
    ['name ending with a space', 'C:\\work\\a.txt ', MESSAGES.badName],
    ['folder ending with a space', 'C:\\work\\dir \\a.txt', MESSAGES.badName],
    ['trailing separator', 'C:\\work\\dir\\', MESSAGES.folder],
    ['control character', 'C:\\work\\a\n.txt', MESSAGES.badChars],
    ['NUL character', 'C:\\work\\a\0.txt', MESSAGES.badChars],
    ['too long', `C:\\work\\${'a'.repeat(1100)}`, MESSAGES.tooLong]
  ])('refuses %s', async (label, input, error) => {
    const { result, realpath } = await resolve(input)
    expect(result).toEqual({ ok: false, error })
    expect(realpath).not.toHaveBeenCalled()
  })

  it('takes forward slashes on Windows', async () => {
    const { result } = await resolve('C:/work/dist/app.jar')
    expect(result).toEqual({ ok: true, path: 'C:\\work\\dist\\app.jar', requestedPath: 'C:\\work\\dist\\app.jar' })
  })

  it('works with POSIX paths too', async () => {
    const realpath = vi.fn(async (target) => target)
    const inside = await resolveLocalPath('/home/me/work/a.txt', { roots: ['/home/me/work'], userDataDir: '/home/me/.config/app', realpath, pathApi: posix })
    const outside = await resolveLocalPath('/home/me/.ssh/id_rsa', { roots: ['/home/me/work'], userDataDir: '/home/me/.config/app', realpath, pathApi: posix })
    const relative = await resolveLocalPath('work/a.txt', { roots: ['/home/me/work'], realpath, pathApi: posix })
    expect(inside.ok).toBe(true)
    expect(outside).toEqual({ ok: false, error: MESSAGES.outside })
    expect(relative).toEqual({ ok: false, error: MESSAGES.notAbsolutePosix })
  })
})

describe('isInside', () => {
  it('knows a folder from its neighbours', () => {
    expect(isInside(win, 'C:\\work', 'C:\\work\\a')).toBe(true)
    expect(isInside(win, 'C:\\work', 'C:\\work')).toBe(true)
    expect(isInside(win, 'C:\\work', 'C:\\work2\\a')).toBe(false)
    expect(isInside(win, 'C:\\work', 'D:\\work\\a')).toBe(false)
    expect(isInside(win, 'C:\\', 'C:\\Users\\me')).toBe(true)
    // Review: a name that merely starts with two dots is not a way out
    expect(isInside(win, 'C:\\work', 'C:\\work\\..notes')).toBe(true)
    expect(isInside(win, 'C:\\work', 'C:\\work\\..dir\\a')).toBe(true)
    expect(isInside(posix, '/srv/work', '/srv/work/..notes')).toBe(true)
    expect(isInside(posix, '/srv/work', '/srv')).toBe(false)
  })
})
