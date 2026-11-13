import { describe, it, expect } from 'vitest'
import { createRequire } from 'module'

const require = createRequire(import.meta.url)
const { decodeSessionName, readPuttyText, readPuttyFile } = require('./putty.js')

const reg = [
  'Windows Registry Editor Version 5.00',
  '',
  '[HKEY_CURRENT_USER\\Software\\SimonTatham\\PuTTY\\Sessions]',
  '',
  '[HKEY_CURRENT_USER\\Software\\SimonTatham\\PuTTY\\Sessions\\Default%20Settings]',
  '"HostName"=""',
  '',
  '[HKEY_CURRENT_USER\\Software\\SimonTatham\\PuTTY\\Sessions\\MBRIS_TG]',
  '"HostName"="admin@10.1.2.3"',
  '"PortNumber"=dword:00000016',
  '"Protocol"="ssh"',
  '"PublicKeyFile"="C:\\\\keys\\\\mbris.ppk"',
  '"ProxyMethod"=dword:00000006',
  '"ProxyHost"="bastion.example.com"',
  '"ProxyPort"=dword:000008ae',
  '"ProxyUsername"="jump"',
  '',
  '[HKEY_CURRENT_USER\\Software\\SimonTatham\\PuTTY\\Sessions\\%B1%E2%BA%BB%20%BC%B3%C1%A4]',
  '"HostName"="db.example.com"',
  '"PortNumber"=dword:00000d3d',
  '"UserName"="dba"',
  '"Protocol"="ssh"',
  '"ProxyMethod"=dword:00000002',
  '"ProxyHost"="socks.example.com"',
  '',
  '[HKEY_CURRENT_USER\\Software\\SimonTatham\\PuTTY\\Sessions\\serial]',
  '"Protocol"="serial"',
  ''
].join('\r\n')

describe('putty', () => {
  it('decodes percent-encoded Korean session names', () => {
    expect(decodeSessionName('%B1%E2%BA%BB%20%BC%B3%C1%A4')).toBe('기본 설정')
    expect(decodeSessionName('MBRIS_TG')).toBe('MBRIS_TG')
  })

  it('reads SSH sessions: user@host, port, key file and an SSH proxy as the jump host', () => {
    const result = readPuttyText(reg)
    expect(result.sessions.map(s => s.name)).toEqual(['MBRIS_TG', '기본 설정'])
    expect(result.sessions[0]).toMatchObject({
      host: '10.1.2.3', username: 'admin', port: 22, authType: 'privateKey', privateKeyPath: 'C:\\keys\\mbris.ppk',
      hasSavedPassword: false, jump: { host: 'bastion.example.com', port: 2222, username: 'jump' }
    })
    // A SOCKS proxy is not a jump host
    expect(result.sessions[1]).toMatchObject({ host: 'db.example.com', port: 3389, username: 'dba', jump: null })
    expect(result.skipped).toEqual({ 'serial 세션': 1 })
  })

  it('reads the UTF-16LE file regedit writes', () => {
    const buffer = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(reg, 'utf16le')])
    expect(readPuttyFile(buffer).sessions).toHaveLength(2)
  })

  it('ignores keys outside the PuTTY sessions', () => {
    const other = '[HKEY_CURRENT_USER\\Software\\Other\\Sessions\\x]\r\n"HostName"="evil"\r\n'
    expect(readPuttyText(other).sessions).toEqual([])
  })
})
