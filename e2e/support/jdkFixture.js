const { EventEmitter } = require('node:events')
const { Readable } = require('node:stream')
const { createHash } = require('node:crypto')
const { temurin17WindowsX64 } = require('../../src/runtimes/fixtures/providers.json')

function zipOf(entries) {
  const files = []
  const directory = []
  let offset = 0
  for (const [name, contents] of Object.entries(entries)) {
    const filename = Buffer.from(name)
    const data = Buffer.from(contents)
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt32LE(data.length, 18)
    local.writeUInt32LE(data.length, 22)
    local.writeUInt16LE(filename.length, 26)
    const central = Buffer.alloc(46)
    central.writeUInt32LE(0x02014b50, 0)
    central.writeUInt32LE(data.length, 20)
    central.writeUInt32LE(data.length, 24)
    central.writeUInt16LE(filename.length, 28)
    central.writeUInt32LE(offset, 42)
    files.push(local, filename, data)
    directory.push(central, filename)
    offset += local.length + filename.length + data.length
  }
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(directory.length / 2, 8)
  end.writeUInt16LE(directory.length / 2, 10)
  end.writeUInt32LE(directory.reduce((total, part) => total + part.length, 0), 12)
  end.writeUInt32LE(offset, 16)
  return Buffer.concat([...files, ...directory, end])
}

function fixtureRequest(handler) {
  return (url, { signal }, respond) => {
    const req = new EventEmitter()
    let response
    req.destroy = error => response ? response.destroy(error) : req.emit('error', error)
    queueMicrotask(() => {
      if (signal?.aborted) return req.destroy(signal.reason)
      try {
        const { status = 200, headers = {}, body = Buffer.alloc(0) } = handler(url)
        response = Object.assign(Readable.from([body]), { statusCode: status, headers })
        respond(response)
      } catch (error) { req.destroy(error) }
    })
    return req
  }
}

const digest = data => createHash('sha256').update(data).digest('hex')
const release = 'JAVA_VERSION="17.0.21.1"\nJAVA_RUNTIME_VERSION="17.0.21.1+2"\nIMPLEMENTOR="Eclipse Adoptium"\nOS_ARCH="amd64"\n'
const jdkFiles = { 'jdk/release': release, 'jdk/bin/java.exe': 'fake-java', 'jdk/bin/javac.exe': 'fake-javac' }

function fakeTemurin({ bytes = zipOf(jdkFiles), checksum = digest(bytes), download } = {}) {
  const builds = structuredClone(temurin17WindowsX64)
  const asset = builds[0].binaries[0].package
  asset.checksum = checksum
  asset.size = bytes.length
  return fixtureRequest(url => {
    if (url.hostname === 'api.adoptium.net') return { body: Buffer.from(JSON.stringify(builds)) }
    if (url.href === asset.link) return download?.(url) ?? { body: bytes, headers: { 'content-length': String(bytes.length) } }
    throw new Error('Unexpected request in the JDK fixture')
  })
}

module.exports = { zipOf, fixtureRequest, digest, release, jdkFiles, fakeTemurin }
