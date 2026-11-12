import { describe, it, expect } from 'vitest'
import { createRequire } from 'module'

const require = createRequire(import.meta.url)
const { matchServerBackup, stampOf, stampInName, listServerBackups, MAX_SERVER_BACKUPS } = require('./serverBackups.js')
const { createFakeSftp } = require('../mcp/fakeSftp.testhelper.js')

const at = (y, mo, d, h = 0, mi = 0, s = 0) => new Date(y, mo - 1, d, h, mi, s).getTime()

describe('matchServerBackup', () => {
  it('takes names people give backups', () => {
    for (const name of [
      'compose.yaml.bak_20261020_1516',
      'compose.yaml.bak',
      'portal.env.bak_20261012',
      'portal.env.bak_20261111105029',
      'compose.yaml.20261020',
      'compose.yaml_2026-10-20',
      'compose.yaml-backup',
      'compose.yaml.orig',
      'compose.yaml.old',
      'compose.yaml~',
      'compose.yaml.BAK'
    ]) {
      const base = name.startsWith('portal') ? 'portal.env' : 'compose.yaml'
      expect(matchServerBackup(name, base), name).toBe(true)
    }
  })

  it('leaves other files alone', () => {
    for (const [name, base] of [
      ['compose.yaml', 'compose.yaml'],
      ['mbris-portal.jar.sha256', 'mbris-portal.jar'],
      ['env.example', 'env'],
      ['compose.yaml.swp', 'compose.yaml'],
      ['compose.yamlx.bak', 'compose.yaml'],
      ['other.yaml.bak', 'compose.yaml'],
      ['compose.yaml.tmp', 'compose.yaml']
    ]) {
      expect(matchServerBackup(name, base), name).toBe(false)
    }
  })
})

describe('matchServerBackup: the many ways people name a backup', () => {
  const BASE = 'index.jsp'

  it('takes a mark after the name', () => {
    for (const name of [
      'index.jsp.261102', 'index.jsp_261102', 'index.jsp-261102', 'index.jsp.26.11.02', 'index.jsp.261102_1530',
      'index.jsp.org', 'index.jsp.ori', 'index.jsp_bak', 'index.jsp.bak2', 'index.jsp.bak_kim', 'index.jsp.261102.kim',
      'index.jsp.1', 'index.jsp_1102', 'index.jspbak', 'index.jsp261102', 'index.jsp.백업', 'index.jsp_수정전'
    ]) expect(matchServerBackup(name, BASE), name).toBe(true)
  })

  it('takes a mark before the extension', () => {
    for (const name of [
      'index_261102.jsp', 'index.261102.jsp', 'index-20261102.jsp', 'index_bak.jsp', 'index.bak.jsp', 'index_old.jsp',
      'index (1).jsp', 'index(2).jsp', 'index - 복사본.jsp', 'index - 복사본 (2).jsp', 'index_1102.jsp',
      'index_backup_261102.jsp', 'index_v2_bak.jsp', 'indexold.jsp'
    ]) expect(matchServerBackup(name, BASE), name).toBe(true)
  })

  it('takes a mark in front of the name', () => {
    for (const name of ['bak_index.jsp', 'old_index.jsp', '261102_index.jsp', '20261102-index.jsp', 'Copy of index.jsp', '복사본 - index.jsp', 'backup.index.jsp']) {
      expect(matchServerBackup(name, BASE), name).toBe(true)
    }
  })

  it('leaves files that are something else', () => {
    for (const name of [
      'index.jsp.template', 'index.jsp.sample', 'index.jsp.sha256', 'index_admin.jsp', 'index2.jsp', 'index_1.jsp', 'index_new.jsp',
      'index_2025.jsp', 'indexer.jsp', 'main_index.jsp', 'sub.index.jsp', 'my-index.jsp', '.index.jsp', 'index.jspx',
      'index.jspx.bak', 'index_backup_admin.jsp', 'index.json'
    ]) expect(matchServerBackup(name, BASE), name).toBe(false)
  })

  it('works for names without an extension and hidden files', () => {
    expect(matchServerBackup('hosts.261102', 'hosts')).toBe(true)
    expect(matchServerBackup('bak_hosts', 'hosts')).toBe(true)
    expect(matchServerBackup('ghosts', 'hosts')).toBe(false)
    expect(matchServerBackup('.env_261102', '.env')).toBe(true)
    expect(matchServerBackup('prod.env', '.env')).toBe(false)
  })
})

describe('stampInName', () => {
  it('reads a short date (year, month, day) wherever the mark is', () => {
    expect(stampInName('index.jsp.261102', 'index.jsp')).toBe(at(2026, 11, 2))
    expect(stampInName('index_261102.jsp', 'index.jsp')).toBe(at(2026, 11, 2))
    expect(stampInName('261102_index.jsp', 'index.jsp')).toBe(at(2026, 11, 2))
    expect(stampInName('index.jsp.261102_1530', 'index.jsp')).toBe(at(2026, 11, 2, 15, 30))
    expect(stampInName('index.jsp.26.11.02', 'index.jsp')).toBe(at(2026, 11, 2))
  })

  it('takes a two-digit year far ahead as the last century, and has no date for a month and day alone', () => {
    expect(stampInName('index.jsp.991231', 'index.jsp')).toBe(at(1999, 12, 31))
    expect(stampInName('index.jsp_1102', 'index.jsp')).toBeNull()
    expect(stampInName('index.jsp.bak', 'index.jsp')).toBeNull()
  })
})

describe('stampOf', () => {
  it('reads a date and time from the name', () => {
    expect(stampOf('.bak_20261020_1516')).toBe(at(2026, 10, 20, 15, 16))
    expect(stampOf('.bak_20261111105029')).toBe(at(2026, 11, 11, 10, 50, 29))
    expect(stampOf('.bak_20261012')).toBe(at(2026, 10, 12))
    expect(stampOf('_2026-10-20')).toBe(at(2026, 10, 20))
  })

  it('ignores numbers that are not a real date', () => {
    expect(stampOf('.bak_20261399')).toBeNull()
    expect(stampOf('.bak')).toBeNull()
    expect(stampOf('.bak_20261020_2599')).toBe(at(2026, 10, 20))
  })
})

describe('listServerBackups', () => {
  const file = (data, mtime = 1000) => ({ type: 'file', data, mtime })

  it('lists backups next to the file, newest first, with the time from the name or the file', async () => {
    const sftp = createFakeSftp({
      '/data': { type: 'dir' },
      '/data/app': { type: 'dir' },
      '/data/app/compose.yaml': file('now'),
      '/data/app/compose.yaml.bak_20261020_1516': file('old'),
      '/data/app/compose.yaml.bak_20261021_1155': file('newer'),
      '/data/app/compose.yaml.orig': file('orig', at(2026, 9, 1) / 1000),
      '/data/app/compose.yaml.sha256': file('x'),
      '/data/app/portal.env.bak': file('other')
    })
    const list = await listServerBackups(sftp, '/data/app/compose.yaml')
    expect(list.map(b => b.name)).toEqual(['compose.yaml.bak_20261021_1155', 'compose.yaml.bak_20261020_1516', 'compose.yaml.orig'])
    expect(list[0]).toMatchObject({ path: '/data/app/compose.yaml.bak_20261021_1155', size: 5, time: at(2026, 10, 21, 11, 55), timeFrom: 'name' })
    expect(list[2]).toMatchObject({ time: at(2026, 9, 1), timeFrom: 'modified' })
  })

  it('skips links and folders that look like backups', async () => {
    const sftp = createFakeSftp({
      '/data': { type: 'dir' },
      '/data/compose.yaml': file('now'),
      '/data/compose.yaml.bak': { type: 'link', target: '/etc/shadow' },
      '/data/compose.yaml.old': { type: 'dir' },
      '/etc': { type: 'dir' },
      '/etc/shadow': file('secret')
    })
    expect(await listServerBackups(sftp, '/data/compose.yaml')).toEqual([])
  })

  it('also matches the name the file was opened by when it is a link', async () => {
    const sftp = createFakeSftp({
      '/srv': { type: 'dir' },
      '/srv/app.conf': file('now'),
      '/srv/app.conf.bak': file('a'),
      '/srv/current.conf.bak': file('b')
    })
    const list = await listServerBackups(sftp, '/srv/app.conf', '/srv/current.conf')
    expect(list.map(b => b.name).sort()).toEqual(['app.conf.bak', 'current.conf.bak'])
  })

  it(`keeps at most ${MAX_SERVER_BACKUPS}`, async () => {
    const tree = { '/d': { type: 'dir' }, '/d/a.txt': file('now') }
    for (let i = 0; i < MAX_SERVER_BACKUPS + 5; i++) tree[`/d/a.txt.bak${i}`] = file('x', 1000 + i)
    const list = await listServerBackups(createFakeSftp(tree), '/d/a.txt')
    expect(list).toHaveLength(MAX_SERVER_BACKUPS)
    expect(list[0].name).toBe(`a.txt.bak${MAX_SERVER_BACKUPS + 4}`)
  })
})
