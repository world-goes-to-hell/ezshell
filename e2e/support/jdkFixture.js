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

const digest = (data, algorithm = 'sha256') => createHash(algorithm).update(data).digest('hex')
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

function fakeEnhanced({ badJbrChecksum = false, badAgentDigest = false } = {}) {
  const temurin = fakeTemurin()
  const json = value => ({ body: Buffer.from(JSON.stringify(value)) })
  const jbr = feature => {
    const version = `${feature}.0.11`
    const tag = `jbr-release-${version}b1163.125`
    const filename = `jbrsdk-${version}-windows-x64-b1163.125.zip`
    const url = `https://cache-redirector.jetbrains.com/intellij-jbr/${filename}`
    const bytes = zipOf({ ...jdkFiles, 'jdk/release':
      `JAVA_VERSION="${version}"\nJAVA_RUNTIME_VERSION="${version}+1163.125"\nIMPLEMENTOR="JetBrains"\nOS_ARCH="amd64"\n` })
    return { tag, filename, url, bytes }
  }
  const packages = [jbr(17), jbr(21)]
  const agent = Buffer.from('agent-fixture')
  const tag = 'RELEASE-2.0.5'
  const name = 'hotswap-agent-2.0.5.jar'
  const agentUrl = `https://github.com/HotswapProjects/HotswapAgent/releases/download/${tag}/${name}`
  const enhanced = fixtureRequest(url => {
    for (const [index, { tag, filename, bytes, url: archive }] of packages.entries()) {
      const feature = index === 0 ? 17 : 21
      if (url.pathname.endsWith(`/git/matching-refs/tags/jbr-release-${feature}.`)) return json([{ ref: `refs/tags/${tag}` }])
      if (url.pathname.endsWith(`/releases/tags/${tag}`)) {
        return json({ tag_name: tag, draft: false, prerelease: false, body: `[SDK](${archive}) [sum](${archive}.checksum)` })
      }
      if (url.href === `${archive}.checksum`) return { body: Buffer.from(`${badJbrChecksum ? '0'.repeat(128) : digest(bytes, 'sha512')}  ${filename}\n`) }
      if (url.href === archive) return { body: bytes }
    }
    if (url.pathname === '/repos/HotswapProjects/HotswapAgent/releases') {
      return json([{ tag_name: tag, draft: false, prerelease: false, assets: [{
        name, state: 'uploaded', browser_download_url: agentUrl, size: agent.length,
        digest: `sha256:${badAgentDigest ? '0'.repeat(64) : digest(agent)}`
      }] }])
    }
    if (url.href === agentUrl) return { body: agent }
    throw new Error('Unexpected request in the enhanced HotSwap fixture')
  })
  return (url, options, respond) => url.hostname === 'api.adoptium.net' || url.pathname.startsWith('/adoptium/')
    ? temurin(url, options, respond) : enhanced(url, options, respond)
}

const tomcatFiles = {
  'bin/catalina.bat': 'fake-catalina',
  'bin/bootstrap.jar': 'fake-bootstrap',
  'conf/server.xml': '<Server />'
}

function fakeApache({ badChecksum = false } = {}) {
  const modern = 'https://downloads.apache.org/tomcat/tomcat-11/'
  const archived = 'https://archive.apache.org/dist/tomcat/tomcat-7/'
  const packs = [[modern, '11.0.29'], [archived, '7.0.109']].map(([base, version]) => {
    const folder = `apache-tomcat-${version}`
    const zip = zipOf(Object.fromEntries(Object.entries(tomcatFiles).map(([file, bytes]) => [`${folder}/${file}`, bytes])))
    return { base, version, url: `${base}v${version}/bin/${folder}.zip`, zip }
  })
  return fixtureRequest(url => {
    for (const { base, version, url: binary, zip } of packs) {
      if (url.href === base) return { body: Buffer.from(`<a href="v${version}/">v${version}/</a>`) }
      if (url.href === `${binary}.sha512`) return { body: Buffer.from(badChecksum ? '0'.repeat(128) : digest(zip, 'sha512')) }
      if (url.href === binary) return { body: zip }
    }
    throw new Error('Unexpected request in the Apache fixture')
  })
}

function fakeGradleNode({ badChecksum = false } = {}) {
  const json = value => ({ body: Buffer.from(JSON.stringify(value)) })
  const gradleVersion = '9.9.2'
  const gradleUrl = `https://services.gradle.org/distributions/gradle-${gradleVersion}-bin.zip`
  const gradle = zipOf({ [`gradle-${gradleVersion}/bin/gradle.bat`]: 'fake-gradle', [`gradle-${gradleVersion}/lib/gradle-launcher-${gradleVersion}.jar`]: 'fake-launcher' })
  const nodeVersion = 'v26.13.1'
  const nodePlatform = `node-${nodeVersion}-win-x64`
  const nodeUrl = `https://nodejs.org/dist/${nodeVersion}`
  const node = zipOf({ [`${nodePlatform}/node.exe`]: 'fake-node' })
  const checksum = bytes => badChecksum ? '0'.repeat(64) : digest(bytes)
  return fixtureRequest(url => {
    if (url.href === 'https://services.gradle.org/versions/current') return json({ version: gradleVersion,
      downloadUrl: gradleUrl, checksumUrl: `${gradleUrl}.sha256`, snapshot: false, nightly: false, releaseNightly: false, activeRc: false })
    if (url.href === `${gradleUrl}.sha256`) return { body: Buffer.from(checksum(gradle)) }
    if (url.href === gradleUrl) return { body: gradle }
    if (url.href === 'https://nodejs.org/dist/index.json') return json([{ version: nodeVersion, lts: 'Fixture', files: ['win-x64-zip'] }])
    if (url.href === `${nodeUrl}/SHASUMS256.txt`) return { body: Buffer.from(`${checksum(node)}  ${nodePlatform}.zip\n`) }
    if (url.href === `${nodeUrl}/${nodePlatform}.zip`) return { body: node }
    throw new Error('Unexpected request in the Gradle/Node fixture')
  })
}

module.exports = { zipOf, fixtureRequest, digest, release, jdkFiles, fakeTemurin, fakeEnhanced, fakeApache, tomcatFiles, fakeGradleNode }
