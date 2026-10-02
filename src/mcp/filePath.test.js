import { describe, it, expect } from 'vitest'
import filePathModule from './filePath.js'

const { resolveRemotePath, MAX_PATH_LENGTH } = filePathModule

const where = { cwd: '/srv/app', home: '/home/deploy' }
const resolved = (input, context = where) => resolveRemotePath(input, context)

describe('resolveRemotePath', () => {
  it.each([
    ['/etc/app/config.yml', '/etc/app/config.yml'],
    ['conf/app.yml', '/srv/app/conf/app.yml'],
    ['./conf/app.yml', '/srv/app/conf/app.yml'],
    ['~/notes.txt', '/home/deploy/notes.txt'],
    ['a/../b.txt', '/srv/app/b.txt'],
    ['//etc///hosts', '/etc/hosts'],
    ['../../../../etc/hosts', '/etc/hosts'],
    ["it's a file.txt", "/srv/app/it's a file.txt"],
    ['로그/배포 메모.txt', '/srv/app/로그/배포 메모.txt'],
    ['~other/file', '/srv/app/~other/file']
  ])('resolves %j', (input, expected) => {
    expect(resolved(input)).toEqual({ ok: true, path: expected })
  })

  it.each([
    ['an empty path', ''],
    ['blanks only', '   '],
    ['a number', 42],
    ['nothing', undefined],
    ['a NUL character', '/etc/a\0b'],
    ['a folder (trailing slash)', '/etc/app/'],
    ['the root', '/'],
    ['the home folder itself', '~'],
    ['the current folder', '.'],
    ['a parent folder', 'conf/..'],
    ['a path that climbs to the root', '../../..']
  ])('refuses %s', (label, input) => {
    const result = resolved(input)
    expect(result.ok).toBe(false)
    expect(typeof result.error).toBe('string')
  })

  it('refuses a path that is too long, before and after resolving', () => {
    expect(resolved(`/${'a'.repeat(MAX_PATH_LENGTH)}`).ok).toBe(false)
    expect(resolved('a'.repeat(MAX_PATH_LENGTH - 3)).ok).toBe(false)
    expect(resolved(`/${'a'.repeat(MAX_PATH_LENGTH - 1)}`).ok).toBe(true)
  })

  it('refuses a relative path when the working directory is unknown', () => {
    expect(resolved('conf/app.yml', { cwd: null, home: '/home/deploy' }).ok).toBe(false)
    expect(resolved('~/a', { cwd: '/srv', home: null }).ok).toBe(false)
    expect(resolved('/etc/hosts', { cwd: null, home: null })).toEqual({ ok: true, path: '/etc/hosts' })
  })

  it('keeps line breaks and other odd characters for the dialog to reveal', () => {
    expect(resolved('/tmp/a\nb')).toEqual({ ok: true, path: '/tmp/a\nb' })
  })
})
