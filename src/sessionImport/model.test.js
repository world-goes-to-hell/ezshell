import { describe, it, expect } from 'vitest'
import { createRequire } from 'module'

const require = createRequire(import.meta.url)
const { createCollector, cleanHost, cleanPort, parseIni, iniGet, MAX_SESSIONS } = require('./model.js')

describe('sessionImport model', () => {
  it('builds folders by path once and keeps the order', () => {
    const c = createCollector('xshell', 'Xshell')
    const a = c.folderFor(['개발', 'MBRIS'])
    const b = c.folderFor(['개발', 'mbris'])
    expect(a).toBe(b)
    c.add({ name: 'web', host: '10.0.0.5', port: '2222', username: 'root', folderId: a })
    const r = c.result()
    expect(r.folders).toEqual([{ id: 'f1', name: '개발', parentId: null }, { id: 'f2', name: 'MBRIS', parentId: 'f1' }])
    expect(r.sessions[0]).toMatchObject({ name: 'web', host: '10.0.0.5', port: 2222, username: 'root', folderId: 'f2', authType: 'password', hasSavedPassword: null, jump: null })
  })

  it('cleans untrusted text: control characters, spaces in hosts, bad ports', () => {
    expect(cleanHost('ho\u202est')).toBe('host')
    expect(cleanHost('a b')).toBe('')
    expect(cleanHost('../etc')).toBe('')
    expect(cleanPort('99999')).toBe(22)
    expect(cleanPort('abc', 2200)).toBe(2200)
    const c = createCollector('x', 'X')
    expect(c.add({ name: 'n\nx', host: '' })).toBe(false)
    c.add({ name: 'n\u0007x', host: 'h', username: 'bad user' })
    expect(c.result().sessions[0]).toMatchObject({ name: 'nx', username: '' })
    expect(c.result().skipped).toEqual({ '호스트 없음': 1 })
  })

  it('marks key sessions and keeps a usable jump host only', () => {
    const c = createCollector('x', 'X')
    c.add({ host: 'h', privateKeyPath: 'C:\\keys\\id', jump: { host: 'bastion', port: 2222, username: 'j' } })
    c.add({ host: 'h2', keyNote: 'Xshell 키: mykey', jump: { host: '' } })
    const [a, b] = c.result().sessions
    expect(a).toMatchObject({ authType: 'privateKey', privateKeyPath: 'C:\\keys\\id', jump: { host: 'bastion', port: 2222, username: 'j' } })
    expect(b).toMatchObject({ authType: 'privateKey', privateKeyPath: '', jump: null })
  })

  it('stops at the session limit and says so', () => {
    const c = createCollector('x', 'X')
    for (let i = 0; i < MAX_SESSIONS + 5; i++) c.add({ host: `h${i}` })
    expect(c.result().sessions).toHaveLength(MAX_SESSIONS)
    expect(c.result().truncated).toBe(true)
  })

  it('reads INI sections and keys without regard to case', () => {
    const ini = parseIni('[CONNECTION]\r\nHost=10.0.0.1\r\nPort=22\r\n; comment\r\n[Connection:Authentication]\r\nUserName=root\r\n')
    expect(iniGet(ini, 'connection', 'host')).toBe('10.0.0.1')
    expect(iniGet(ini, 'CONNECTION:AUTHENTICATION', 'username')).toBe('root')
    expect(iniGet(ini, 'none', 'x')).toBeUndefined()
  })
})

describe('security review fixes', () => {
  it('drops key paths that are not on this PC and says so', () => {
    const c = createCollector('x', 'X')
    const paths = [String.raw`\\attacker\share\id`, '//attacker/share/id', String.raw`\\?\UNC\h\s\id`, String.raw`\\.\pipe\x`, String.raw`keys\id`, '~/.ssh/id', String.raw`%USERPROFILE%\id`]
    for (const p of paths) {
      c.add({ host: 'h', privateKeyPath: p })
    }
    const sessions = c.result().sessions
    expect(sessions.every(s => s.privateKeyPath === '' && s.authType === 'privateKey' && s.keyNote.includes('직접 골라'))).toBe(true)
  })

  it('refuses hosts and users that a command line would read as options or split', () => {
    expect(cleanHost('-oProxyCommand=calc')).toBe('')
    expect(cleanHost('host;rm')).toBe('')
    expect(cleanHost('[fd00::1]')).toBe('[fd00::1]')
    expect(cleanHost('fe80::1%eth0')).toBe('fe80::1%eth0')
    const c = createCollector('x', 'X')
    c.add({ host: 'h', username: '-oX' })
    c.add({ host: 'h', username: 'a@b' })
    expect(c.result().sessions.map(s => s.username)).toEqual(['', ''])
  })
})
