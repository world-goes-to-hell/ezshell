import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { createRequire } from 'module'

const require = createRequire(import.meta.url)
const { createBackupStore, backupTarget, safeSegment, parseBackupName } = require('./backups.js')

let root
beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'ezshell-backups-')) })
afterEach(() => { fs.rmSync(root, { recursive: true, force: true }) })

const server = { sessionName: 'dev', username: 'deploy', host: '10.0.0.5' }

describe('backup folder', () => {
  it('mirrors the server path under the session folder', () => {
    const target = backupTarget(root, server, '/etc/nginx/nginx.conf')
    expect(target).toEqual({ dir: path.join(root, 'dev (deploy@10.0.0.5)', 'etc', 'nginx'), baseName: 'nginx.conf' })
  })

  it('never makes a name that leaves the folder or that Windows refuses', () => {
    expect(safeSegment('..')).toBe('_')
    expect(safeSegment('.')).toBe('_')
    expect(safeSegment('a:b*c')).toBe('a_b_c')
    expect(safeSegment('con')).toBe('_con')
    expect(safeSegment('nul.txt')).toBe('_nul.txt')
    expect(safeSegment('name. ')).toBe('name__')
    expect(safeSegment('.ssh')).toBe('.ssh')
  })

  it('keeps user@host in the folder name whatever the session name', () => {
    const long = { ...server, sessionName: '아주 긴 세션 이름 '.repeat(10) }
    expect(path.basename(path.dirname(backupTarget(root, long, '/etc/a').dir))).toMatch(/\(deploy@10\.0\.0\.5\)$/)
  })

  it('treats reserved names with spaces or superscripts as reserved, and never splits a character', () => {
    expect(safeSegment('CON .txt')).toBe('_CON .txt')
    expect(safeSegment('com¹')).toBe('_com¹')
    expect(Array.from(safeSegment('😀'.repeat(100)))).toHaveLength(80)
  })

  it('uses a short folder for a very long path', () => {
    const long = `/${'a'.repeat(60)}/${'b'.repeat(60)}/${'c'.repeat(60)}/${'d'.repeat(60)}/file.txt`
    const target = backupTarget(root, server, long)
    expect(target.dir.length).toBeLessThan(path.join(root, 'x').length + 120)
    expect(target.baseName).toBe('file.txt')
    expect(backupTarget(root, server, long)).toEqual(target)
  })

  it('reads only its own names', () => {
    expect(parseBackupName('a.conf', 'a.conf.20261105-151200.bak')).toMatchObject({ counter: 1 })
    expect(parseBackupName('a.conf', 'a.conf.20261105-151200-3.bak')).toMatchObject({ counter: 3 })
    expect(parseBackupName('a.conf', 'b.conf.20261105-151200.bak')).toBeNull()
    expect(parseBackupName('a.conf', 'a.conf.20261105-151200.bak.txt')).toBeNull()
    expect(parseBackupName('a.conf', '../a.conf.20261105-151200.bak')).toBeNull()
  })
})

describe('backup store', () => {
  it('does not prune on its own when saving (the caller prunes after its save went through)', async () => {
    const store = createBackupStore({ root, keep: 1 })
    const target = backupTarget(root, server, '/etc/app.conf')
    await store.save(target, 'a')
    await store.save(target, 'b')
    expect(await store.list(target)).toHaveLength(2)
  })

  it('keeps the newest copies only, and never replaces one taken in the same second', async () => {
    const store = createBackupStore({ root, keep: 3, now: () => new Date(2026, 10, 5, 15, 0, 0) })
    const target = backupTarget(root, server, '/etc/app.conf')
    for (const content of ['1', '2', '3', '4', '5']) await store.prune(target, await store.save(target, content))
    const listed = await store.list(target)
    expect(listed.map(entry => entry.name)).toEqual(['app.conf.20261105-150000-5.bak', 'app.conf.20261105-150000-4.bak', 'app.conf.20261105-150000-3.bak'])
    expect(await store.read(target, listed[0].name)).toBe('5')
  })

  it('leaves other files in the folder alone', async () => {
    const store = createBackupStore({ root, keep: 1 })
    const target = backupTarget(root, server, '/etc/app.conf')
    fs.mkdirSync(target.dir, { recursive: true })
    fs.writeFileSync(path.join(target.dir, 'notes.txt'), 'mine')
    await store.prune(target, await store.save(target, 'a'))
    await store.prune(target, await store.save(target, 'b'))
    expect(fs.readFileSync(path.join(target.dir, 'notes.txt'), 'utf8')).toBe('mine')
    expect(await store.list(target)).toHaveLength(1)
  })
})
