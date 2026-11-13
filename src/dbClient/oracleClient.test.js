import { describe, it, expect, beforeEach, vi } from 'vitest'
import crypto from 'crypto'
import fs from 'fs'
import os from 'os'
import path from 'path'
import zlib from 'zlib'
import { EventEmitter } from 'events'
import { PassThrough } from 'stream'
import unzip from './unzip.js'
import oracleClient from './oracleClient.js'

const { extractZip, safeTarget } = unzip
const { createOracleClientManager, isOracleHost } = oracleClient

/** A zip archive of the given entries ({ name, data, isDeflated }), built by hand */
function zipOf(entries) {
  const locals = []
  const directory = []
  let offset = 0
  for (const { name, data = Buffer.alloc(0), isDeflated = false, flags = 0 } of entries) {
    const nameBytes = Buffer.from(name)
    const body = isDeflated ? zlib.deflateRawSync(data) : data
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(flags, 6)
    local.writeUInt16LE(isDeflated ? 8 : 0, 8)
    local.writeUInt32LE(body.length, 18)
    local.writeUInt32LE(data.length, 22)
    local.writeUInt16LE(nameBytes.length, 26)
    const central = Buffer.alloc(46)
    central.writeUInt32LE(0x02014b50, 0)
    central.writeUInt16LE(flags, 8)
    central.writeUInt16LE(isDeflated ? 8 : 0, 10)
    central.writeUInt32LE(body.length, 20)
    central.writeUInt32LE(data.length, 24)
    central.writeUInt16LE(nameBytes.length, 28)
    central.writeUInt32LE(offset, 42)
    locals.push(local, nameBytes, body)
    directory.push(central, nameBytes)
    offset += 30 + nameBytes.length + body.length
  }
  const directoryBytes = Buffer.concat(directory)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(entries.length, 8)
  end.writeUInt16LE(entries.length, 10)
  end.writeUInt32LE(directoryBytes.length, 12)
  end.writeUInt32LE(offset, 16)
  return Buffer.concat([...locals, directoryBytes, end])
}

let dir
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ezshell-oracle-'))
})

describe('extractZip', () => {
  it('writes stored and deflated files and folders', async () => {
    const zipPath = path.join(dir, 'a.zip')
    const big = Buffer.from('oracle '.repeat(5000))
    fs.writeFileSync(zipPath, zipOf([{ name: 'client/' }, { name: 'client/oci.dll', data: big, isDeflated: true }, { name: 'client/README', data: Buffer.from('read me') }, { name: 'client/empty.txt' }]))
    const out = path.join(dir, 'out')
    expect(await extractZip(zipPath, out)).toBe(3)
    expect(fs.readFileSync(path.join(out, 'client/oci.dll')).equals(big)).toBe(true)
    expect(fs.readFileSync(path.join(out, 'client/README'), 'utf8')).toBe('read me')
    expect(fs.statSync(path.join(out, 'client/empty.txt')).size).toBe(0)
  })

  it.each(['../evil.dll', 'client/../../evil.dll', '/abs/evil.dll', 'C:/Windows/evil.dll', 'client\\..\\..\\evil.dll'])('writes nothing when an entry would leave the folder: %s', async (name) => {
    const zipPath = path.join(dir, 'a.zip')
    fs.writeFileSync(zipPath, zipOf([{ name: 'client/good.txt', data: Buffer.from('ok') }, { name, data: Buffer.from('bad') }]))
    const out = path.join(dir, 'out')
    await expect(extractZip(zipPath, out)).rejects.toThrow()
    // Checked before anything was written: not even the good file is there
    expect(fs.existsSync(path.join(out, 'client/good.txt'))).toBe(false)
    expect(fs.existsSync(path.join(dir, 'evil.dll'))).toBe(false)
  })

  it('refuses what it does not read (an encrypted entry, a file that is not a zip)', async () => {
    const encrypted = path.join(dir, 'e.zip')
    fs.writeFileSync(encrypted, zipOf([{ name: 'a.txt', data: Buffer.from('x'), flags: 1 }]))
    await expect(extractZip(encrypted, path.join(dir, 'out'))).rejects.toThrow()
    const notZip = path.join(dir, 'n.zip')
    fs.writeFileSync(notZip, Buffer.alloc(200, 7))
    await expect(extractZip(notZip, path.join(dir, 'out'))).rejects.toThrow()
  })

  it('knows which names stay inside the folder', () => {
    expect(safeTarget(dir, 'a/b.txt')).toBe(path.join(dir, 'a', 'b.txt'))
    for (const name of ['', '..', '../x', 'a/../../x', '/x', 'C:\\x', 'a\0b', 'a<b']) expect(safeTarget(dir, name), name).toBeNull()
  })
})

describe('createOracleClientManager', () => {
  const archive = zipOf([{ name: 'instantclient_test/' }, { name: 'instantclient_test/oci.dll', data: Buffer.from('library'), isDeflated: true }, { name: 'instantclient_test/BASIC_LICENSE', data: Buffer.from('terms') }])
  const pack = { version: '19.test', url: 'https://download.oracle.com/client.zip', bytes: archive.length, sha256: crypto.createHash('sha256').update(archive).digest('hex'), folder: 'instantclient_test', library: 'oci.dll' }

  /** An https.get stand-in: answers per URL with { status, body, location } */
  function fakeRequest(answers) {
    const asked = []
    const request = vi.fn((url, options, onResponse) => {
      asked.push(url)
      const req = new EventEmitter()
      req.destroy = (err) => queueMicrotask(() => req.emit('error', err || new Error('destroyed')))
      const answer = answers[url] || { status: 404 }
      queueMicrotask(() => {
        const res = new PassThrough()
        res.statusCode = answer.status ?? 200
        res.headers = answer.location ? { location: answer.location } : {}
        onResponse(res)
        res.end(answer.body ?? Buffer.alloc(0))
      })
      return req
    })
    return { request, asked }
  }
  const manager = (answers, overrides = {}) => {
    const { request, asked } = fakeRequest(answers)
    return { client: createOracleClientManager({ baseDir: path.join(dir, 'oracle-client'), request, platform: 'win32', arch: 'x64', pack, ...overrides }), asked }
  }

  it('downloads, checks and unpacks, and then says where the libraries are', async () => {
    const { client } = manager({ [pack.url]: { body: archive } })
    expect(client.status()).toMatchObject({ isSupported: true, isInstalled: false, version: '19.test', bytes: archive.length })
    expect(client.location()).toBeNull()
    const steps = []
    await client.install((progress) => steps.push(progress.step))
    expect(steps[0]).toBe('download')
    expect(steps).toContain('unpack')
    expect(client.status().isInstalled).toBe(true)
    const where = client.location()
    expect(fs.readFileSync(path.join(where.libDir, 'oci.dll'), 'utf8')).toBe('library')
    // Stops are sent in-band: a tunnel carries no out-of-band data
    expect(fs.readFileSync(path.join(where.configDir, 'sqlnet.ora'), 'utf8')).toContain('DISABLE_OOB=ON')
    // The download and the unpacking folder are gone
    expect(fs.readdirSync(path.join(dir, 'oracle-client')).sort()).toEqual(['instantclient_test', 'network'])
  })

  it('installs nothing when the file is not the one that was published', async () => {
    const tampered = Buffer.from(archive)
    tampered[40] ^= 0xff
    const { client } = manager({ [pack.url]: { body: tampered } })
    await expect(client.install()).rejects.toMatchObject({ code: 'EZ_CHECKSUM' })
    expect(client.status().isInstalled).toBe(false)
    expect(fs.readdirSync(path.join(dir, 'oracle-client'))).toEqual([])
    const { client: short } = manager({ [pack.url]: { body: archive.subarray(0, archive.length - 5) } })
    await expect(short.install()).rejects.toThrow()
    expect(short.status().isInstalled).toBe(false)
  })

  it('follows a redirect only to Oracle\'s own hosts', async () => {
    const elsewhere = manager({ [pack.url]: { status: 302, location: 'https://evil.example/client.zip' }, 'https://evil.example/client.zip': { body: archive } })
    await expect(elsewhere.client.install()).rejects.toThrow()
    expect(elsewhere.asked).toEqual([pack.url])
    const within = manager({ [pack.url]: { status: 302, location: 'https://edelivery.oracle.com/client.zip' }, 'https://edelivery.oracle.com/client.zip': { body: archive } })
    await within.client.install()
    expect(within.client.status().isInstalled).toBe(true)
  })

  it('says so when Oracle\'s server does not give the file', async () => {
    const { client } = manager({ [pack.url]: { status: 404 } })
    await expect(client.install()).rejects.toMatchObject({ code: 'EZ_DOWNLOAD' })
  })

  it('is for Windows x64 only, and removes what it installed', async () => {
    const { client: other } = manager({ [pack.url]: { body: archive } }, { platform: 'darwin' })
    expect(other.status().isSupported).toBe(false)
    await expect(other.install()).rejects.toThrow()
    const { client } = manager({ [pack.url]: { body: archive } })
    await client.install()
    client.remove()
    expect(client.status().isInstalled).toBe(false)
    expect(client.location()).toBeNull()
  })

  it('knows Oracle\'s hosts', () => {
    for (const url of ['https://download.oracle.com/x.zip', 'https://oracle.com/x', 'https://a.b.oracle.com/x']) expect(isOracleHost(url), url).toBe(true)
    for (const url of ['http://download.oracle.com/x.zip', 'https://oracle.com.evil.example/x', 'https://evil.example/oracle.com', 'https://notoracle.com/x', 'file:///c:/x', '']) expect(isOracleHost(url), url).toBe(false)
  })
})
