import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import zlib from 'zlib'
import { createRequire } from 'module'

const require = createRequire(import.meta.url)
const { readXsh, readSessionsFolder, readSessionFile, readXts, decodeSessionFile } = require('./xshell.js')

const xsh = ({ host = '10.0.0.5', port = 22, user = 'root', protocol = 'SSH', password = 'encrypted==', key = '' } = {}) =>
  `[SessionInfo]\r\nVersion=8.1\r\n[CONNECTION]\r\nPort=${port}\r\nHost=${host}\r\nProtocol=${protocol}\r\n[CONNECTION:AUTHENTICATION]\r\nPassword=${password}\r\nUserKey=${key}\r\nUserName=${user}\r\n`
const utf16 = (text) => Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, 'utf16le')])

/** A zip with stored (uncompressed) entries */
function makeZip(files) {
  const locals = []
  const centrals = []
  let offset = 0
  for (const [name, data] of files) {
    const nameBuf = Buffer.from(name, 'utf8')
    const crc = zlib.crc32(data)
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(0x0800, 6); local.writeUInt16LE(0, 8)
    local.writeUInt32LE(crc, 14); local.writeUInt32LE(data.length, 18); local.writeUInt32LE(data.length, 22); local.writeUInt16LE(nameBuf.length, 26)
    const central = Buffer.alloc(46)
    central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6); central.writeUInt16LE(0x0800, 8)
    central.writeUInt32LE(crc, 16); central.writeUInt32LE(data.length, 20); central.writeUInt32LE(data.length, 24); central.writeUInt16LE(nameBuf.length, 28)
    central.writeUInt32LE(offset, 42)
    locals.push(local, nameBuf, data)
    centrals.push(central, nameBuf)
    offset += 30 + nameBuf.length + data.length
  }
  const centralBuf = Buffer.concat(centrals)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10)
  end.writeUInt32LE(centralBuf.length, 12); end.writeUInt32LE(offset, 16)
  return Buffer.concat([...locals, centralBuf, end])
}

let dir
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ezshell-xshell-')) })
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }) })

describe('xshell', () => {
  it('reads host, port, user and whether a password was saved (never the password)', () => {
    const fields = readXsh(xsh({ port: 2222 }))
    expect(fields).toMatchObject({ host: '10.0.0.5', port: '2222', username: 'root', hasSavedPassword: true, keyNote: '' })
    expect(JSON.stringify(fields)).not.toContain('encrypted')
  })

  it('marks a key from the Xshell key store and skips other protocols', () => {
    expect(readXsh(xsh({ key: 'mykey', password: '' })).keyNote).toContain('mykey')
    expect(readXsh(xsh({ protocol: 'TELNET' })).skip).toContain('TELNET')
    expect(readXsh(xsh({ protocol: 'SFTP' })).skip).toBeUndefined()
  })

  it('decodes UTF-16LE with or without a BOM', () => {
    expect(decodeSessionFile(utf16('[A]\r\nk=한글'))).toBe('[A]\r\nk=한글')
    expect(decodeSessionFile(Buffer.from('[A]\r\nk=v', 'utf16le'))).toBe('[A]\r\nk=v')
  })

  it('turns the sessions folder tree into folders', async () => {
    fs.mkdirSync(path.join(dir, '개발', 'MBRIS'), { recursive: true })
    fs.writeFileSync(path.join(dir, '개발', 'MBRIS', '[개발] MBRIS.xsh'), utf16(xsh()))
    fs.writeFileSync(path.join(dir, 'top.xsh'), utf16(xsh({ host: 'h2', password: '' })))
    fs.writeFileSync(path.join(dir, 'notes.txt'), 'x')
    fs.writeFileSync(path.join(dir, 'tel.xsh'), utf16(xsh({ protocol: 'TELNET' })))
    const result = await readSessionsFolder(dir)
    expect(result.folders.map(f => [f.name, f.parentId])).toEqual([['개발', null], ['MBRIS', 'f1']])
    expect(result.sessions.map(s => [s.name, s.folderId, s.hasSavedPassword])).toEqual([['[개발] MBRIS', 'f2', true], ['top', null, false]])
    expect(result.skipped).toEqual({ 'TELNET 세션': 1 })
  })

  it('reads one chosen file', () => {
    const result = readSessionFile('C:\\x\\web.xsh', utf16(xsh()))
    expect(result.sessions[0]).toMatchObject({ name: 'web', host: '10.0.0.5' })
  })

  it('reads an export zip, keeping folders and refusing paths that climb out', async () => {
    const zip = makeZip([
      ['Sessions/개발/a.xsh', utf16(xsh({ host: 'a.example.com' }))],
      ['Sessions/b.xsh', utf16(xsh({ host: 'b.example.com' }))],
      ['../evil.xsh', utf16(xsh({ host: 'evil' }))],
      ['Sessions/readme.txt', Buffer.from('x')]
    ])
    const result = await readXts(zip)
    expect(result.sessions.map(s => [s.name, s.host])).toEqual([['a', 'a.example.com'], ['b', 'b.example.com']])
    expect(result.folders.map(f => f.name)).toEqual(['개발'])
  })

  it('refuses something that is not a zip', async () => {
    await expect(readXts(Buffer.from('not a zip'))).rejects.toThrow()
  })
})
