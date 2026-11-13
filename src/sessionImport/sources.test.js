import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { createRequire } from 'module'

const require = createRequire(import.meta.url)
const { createSessionImport } = require('./sources.js')

let root
let importer
const xsh = '[CONNECTION]\r\nHost=10.0.0.5\r\nPort=22\r\nProtocol=SSH\r\n[CONNECTION:AUTHENTICATION]\r\nUserName=root\r\nPassword=\r\n'

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'ezshell-import-'))
  const documents = path.join(root, 'Documents')
  fs.mkdirSync(path.join(documents, 'NetSarang Computer', '8', 'Xshell', 'Sessions', '개발'), { recursive: true })
  fs.writeFileSync(path.join(documents, 'NetSarang Computer', '8', 'Xshell', 'Sessions', '개발', 'web.xsh'), Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(xsh, 'utf16le')]))
  fs.mkdirSync(path.join(root, '.ssh'))
  fs.writeFileSync(path.join(root, '.ssh', 'config'), 'Host box\n  HostName box.example.com\n')
  importer = createSessionImport({
    platform: 'win32',
    getPath: () => documents,
    env: { APPDATA: path.join(root, 'AppData') },
    home: root,
    // No PuTTY on this "PC"
    execFile: (cmd, args, opts, cb) => cb(new Error('not found'))
  })
})
afterEach(() => { fs.rmSync(root, { recursive: true, force: true }) })

describe('session import sources', () => {
  it('lists the programs found and reads one by id', async () => {
    const list = await importer.listSources()
    expect(list.map(s => s.id)).toEqual(['xshell-8', 'ssh-config'])
    const result = await importer.readSource('xshell-8')
    expect(result.sessions[0]).toMatchObject({ name: 'web', host: '10.0.0.5', hasSavedPassword: false })
    expect(result.folders[0].name).toBe('개발')
  })

  it('refuses an id that was not in the last listing', async () => {
    await expect(importer.readSource('putty')).rejects.toThrow('목록에 없는')
    await expect(importer.readSource({ path: 'C:\\' })).rejects.toThrow()
  })

  it('reads a picked file by its name or content, and refuses unknown or huge files', async () => {
    const config = path.join(root, 'servers.txt')
    fs.writeFileSync(config, 'Host a\n  HostName a.example.com\n')
    expect((await importer.readFile(config)).source).toBe('ssh-config')
    const unknown = path.join(root, 'x.bin')
    fs.writeFileSync(unknown, 'hello')
    await expect(importer.readFile(unknown)).rejects.toThrow('알 수 없습니다')
    const huge = path.join(root, 'big.reg')
    fs.writeFileSync(huge, Buffer.alloc(5 * 1024 * 1024 + 1))
    await expect(importer.readFile(huge)).rejects.toThrow('너무 큽니다')
  })
})
