import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { gzipSync } from 'node:zlib'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { Header } from 'tar'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { approvedUrl, downloadArchive, readJson } from './download.js'
import { extractArchive } from './archive.js'
import { findBuild, parseTemurin, parseZulu, pickZulu } from './providers.js'
import { findLocalJdks, parseRelease } from './discovery.js'
import { requiredFeature } from './required.js'
import { createRuntimes } from './index.js'
import { registerRuntimesIpc } from './ipc.js'
import providers from './fixtures/providers.json'
import { digest, fakeTemurin, fixtureRequest, jdkFiles, release, zipOf } from '../../e2e/support/jdkFixture.js'

const platform = 'win32'
const arch = 'x64'
const selection = { feature: 17, platform, arch }
let root

beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'ezshell-jdk-test-')) })
afterEach(() => { fs.rmSync(root, { recursive: true, force: true }) })

const put = (name, content) => {
  const filename = path.join(root, name)
  fs.mkdirSync(path.dirname(filename), { recursive: true })
  fs.writeFileSync(filename, content)
  return filename
}

function startResponse(reply, bytes) {
  const request = new EventEmitter()
  const response = Object.assign(new PassThrough(), { statusCode: 200, headers: {} })
  request.destroy = error => response.destroy(error)
  queueMicrotask(() => { reply(response); response.write(bytes) })
  return request
}

describe('JDK provider metadata', () => {
  it('reads the Temurin package URL and checksum from an actual release response', () => {
    const pack = parseTemurin(providers.temurin17WindowsX64, selection)
    expect(pack).toMatchObject({ vendor: 'temurin', version: '17.0.21.1+2', feature: 17, arch, archive: 'zip', sizeBytes: 191150540,
      sha256: 'eafba0944f777abdc74d5aad16049c9b5a1275b6ce99e2939ba9f7f3e6f08c87' })
    expect(pack.url).toContain('github.com/adoptium/')
    expect(parseTemurin(providers.temurin17WindowsX64, { ...selection, arch: 'arm64' })).toBeNull()
  })

  it('selects the latest matching Zulu architecture and reads SHA-256 from its details', () => {
    const row = pickZulu(providers.zulu17Windows, selection)
    const detail = providers.zulu17WindowsX64Detail
    expect(row.package_uuid).toBe(detail.package_uuid)
    expect(parseZulu(detail, row, selection)).toMatchObject({ vendor: 'zulu', version: '17.0.21.1+2', arch,
      sha256: '78865bdbc82b1164e475c36d471f53880250a768385bc8e4132598d75b58bc36', sizeBytes: 196357000 })
    expect(parseZulu({ ...detail, availability_type: 'SA' }, row, selection)).toBeNull()
  })

  it('reports no build when the official public legacy query has no result', async () => {
    const query = vi.fn(url => {
      expect(url.hostname).toBe('api.azul.com')
      expect(url.searchParams.get('java_version')).toBe('7')
      expect(url.searchParams.get('availability_types')).toBe('CA')
      return { body: Buffer.from('[]') }
    })
    expect(await findBuild('zulu', 7, { platform, arch, request: fixtureRequest(query) })).toBeNull()
    expect(query).toHaveBeenCalledOnce()
  })
})

describe('JDK downloads and archives', () => {
  it('limits the entire metadata response to 30 seconds', async () => {
    vi.useFakeTimers()
    try {
      const request = vi.fn((_url, _options, reply) => startResponse(reply, '['))
      const lookup = readJson('https://api.adoptium.net/list', { request })
      const rejected = expect(lookup).rejects.toThrow(/30초/)
      await vi.advanceTimersByTimeAsync(30_000)
      await rejected
      expect(request).toHaveBeenCalledOnce()
    } finally { vi.useRealTimers() }
  })

  it('stops an archive download at 30 minutes and removes its staging directory', async () => {
    vi.useFakeTimers()
    try {
      const metadata = fakeTemurin()
      const request = (url, options, reply) => url.hostname === 'api.adoptium.net'
        ? metadata(url, options, reply) : startResponse(reply, Buffer.from('partial'))
      const runtimes = createRuntimes({ userData: root, platform, arch, home: root, env: {}, request })
      const progress = vi.fn()
      const install = runtimes.install('temurin', 17, progress)
      const rejected = expect(install).rejects.toThrow(/30분/)
      await vi.waitFor(() => expect(progress).toHaveBeenCalledWith(expect.objectContaining({ phase: 'download', received: 7 })))
      await vi.advanceTimersByTimeAsync(30 * 60_000)
      await rejected
      expect(runtimes.list()).toEqual([])
      expect(fs.readdirSync(path.join(root, 'runtimes', 'jdk'))).toEqual([])
      expect(progress).toHaveBeenLastCalledWith(null)
    } finally { vi.useRealTimers() }
  })

  it('uses exact HTTPS hosts and fails before contacting a denied redirect', async () => {
    for (const address of ['http://api.adoptium.net/a', 'https://api.adoptium.net.invalid/a', 'https://user@github.com/a', 'https://github.com:8443/a']) {
      expect(approvedUrl(address)).toBeNull()
    }
    const hit = vi.fn(() => ({ status: 302, headers: { location: 'https://release-assets.githubusercontent.com.evil.example/jdk.zip' } }))
    const target = path.join(root, 'jdk.zip')
    await expect(downloadArchive({ url: 'https://cdn.azul.com/jdk.zip', sha256: digest(Buffer.from('x')) }, target,
      { request: fixtureRequest(hit) })).rejects.toThrow(/허용되지 않은/)
    expect(hit).toHaveBeenCalledOnce()
    expect(fs.existsSync(target)).toBe(false)
  })

  it.each(['objects.githubusercontent.com', 'release-assets.githubusercontent.com'])('follows a GitHub redirect to %s and verifies its bytes', async (host) => {
    const bytes = Buffer.from('fixture')
    const request = fixtureRequest(url => url.hostname === 'github.com' ?
      { status: 302, headers: { location: `https://${host}/jdk.zip` } } : { body: bytes })
    const target = path.join(root, 'jdk.zip')
    expect(await downloadArchive({ url: 'https://github.com/jdk.zip', sha256: digest(bytes) }, target, { request })).toBe(bytes.length)
    expect(fs.readFileSync(target)).toEqual(bytes)
  })

  it('rejects a checksum mismatch without publishing an installation', async () => {
    const runtimes = createRuntimes({ userData: root, platform, arch, home: root, env: {}, request: fakeTemurin({ checksum: 'a'.repeat(64) }) })
    await expect(runtimes.install('temurin', 17)).rejects.toThrow(/SHA-256/)
    expect(runtimes.list()).toEqual([])
    expect(fs.readdirSync(path.join(root, 'runtimes', 'jdk'))).toEqual([])
  })

  it('rejects an unsafe ZIP entry before writing even the preceding safe entries', async () => {
    const archive = put('sample.zip', zipOf({ 'jdk/release': release, '../out.txt': 'outside' }))
    const target = path.join(root, 'unpack')
    await expect(extractArchive(archive, target, 'zip')).rejects.toThrow()
    expect(fs.existsSync(target)).toBe(false)
    expect(fs.existsSync(path.join(root, 'out.txt'))).toBe(false)
  })

  function tarOf(entries) {
    const blocks = []
    for (const { name, body = '', type = 'File', linkpath } of entries) {
      const data = Buffer.from(body)
      const header = new Header({ path: name, size: data.length, mode: 0o755, type, linkpath })
      header.encode()
      blocks.push(header.block, data, Buffer.alloc((512 - data.length % 512) % 512))
    }
    return gzipSync(Buffer.concat([...blocks, Buffer.alloc(1024)]))
  }

  it('rejects a tar path or link outside the staging directory before any extraction', async () => {
    const target = path.join(root, 'unpack')
    for (const bad of [{ name: '../out.txt', body: 'outside' }, { name: 'jdk/src', type: 'SymbolicLink', linkpath: '../../outside' }]) {
      const archive = put('sample.tar.gz', tarOf([{ name: 'jdk/release', body: release }, bad]))
      await expect(extractArchive(archive, target, 'tar.gz')).rejects.toThrow()
      expect(fs.existsSync(target)).toBe(false)
    }
  })

  it.each([['jdk/file', 'jdk/file'], ['jdk/file', 'jdk/FILE'], ['jdk/One/a', 'jdk/one/b']])('rejects colliding tar paths %s and %s before extraction', async (first, second) => {
    const target = path.join(root, 'unpack')
    const archive = put('duplicate.tar.gz', tarOf([{ name: first }, { name: second }]))
    await expect(extractArchive(archive, target, 'tar.gz')).rejects.toThrow()
    expect(fs.existsSync(target)).toBe(false)
  })

  it('rejects a directory symlink back to its ancestor', async () => {
    const target = path.join(root, 'unpack')
    const archive = put('loop.tar.gz', tarOf([
      { name: 'jdk', type: 'Directory' }, { name: 'jdk/lib/jdk', type: 'SymbolicLink', linkpath: '..' }
    ]))
    await expect(extractArchive(archive, target, 'tar.gz')).rejects.toThrow()
    expect(fs.existsSync(target)).toBe(false)
  })

  it('extracts an eligible tar.gz and preserves executable permissions', async () => {
    const target = path.join(root, 'unpack')
    const archive = put('sample.tar.gz', tarOf([{ name: 'jdk/bin/java', body: 'fixture' }]))
    await extractArchive(archive, target, 'tar.gz')
    const java = path.join(target, 'jdk', 'bin', 'java')
    expect(fs.readFileSync(java, 'utf8')).toBe('fixture')
    if (process.platform !== 'win32') expect(fs.statSync(java).mode & 0o100).not.toBe(0)
  })
})

describe('JDK inventory and project requirements', () => {
  it('sweeps old staging on first use and again before installation without removing other directories', async () => {
    const base = path.join('runtimes', 'jdk')
    put(path.join(base, '.install-leftover', 'part'), 'partial')
    put(path.join(base, '.remove-leftover', 'file'), 'remaining')
    put(path.join(base, 'keep', 'file'), 'keep')
    const live = `.install-${process.ppid}-active`
    put(path.join(base, live, 'part'), 'active in another process')
    const runtimes = createRuntimes({ userData: root, platform, arch, home: root, env: {}, request: fakeTemurin() })
    runtimes.list()
    expect(fs.readdirSync(path.join(root, base)).sort()).toEqual([live, 'keep'])
    put(path.join(base, '.remove-between-installs', 'file'), 'remaining')
    await runtimes.install('temurin', 17)
    expect(fs.readdirSync(path.join(root, base)).sort()).toEqual([live, 'keep', 'temurin-17.0.21.1+2-x64'])
  })

  it('discovers a local JDK by release file, deduplicates JAVA_HOME, and keeps its path private', () => {
    const home = path.join(root, '.gradle', 'jdks', 'temurin-17')
    for (const [name, bytes] of Object.entries(jdkFiles)) put(`.gradle/jdks/temurin-17/${name.slice(4)}`, bytes)
    expect(findLocalJdks({ env: { JAVA_HOME: home }, home: root, platform })).toEqual([
      expect.objectContaining({ vendor: 'temurin', feature: 17, arch: 'x64', managed: false, folder: 'temurin-17' })
    ])
    const runtimes = createRuntimes({ userData: root, platform, arch, home: root, env: { JAVA_HOME: home } })
    const list = runtimes.list()
    expect(JSON.stringify(list)).not.toContain(root)
    expect(runtimes.javaHomeOf(list[0].id)).toBe(fs.realpathSync(home))
    expect(() => runtimes.remove(list[0].id)).toThrow(/받은 JDK만/)
    expect(fs.existsSync(home)).toBe(true)
    expect(parseRelease('JAVA_VERSION="1.7.0_352"\nIMPLEMENTOR="Azul Systems"')).toMatchObject({ feature: 7, vendor: 'zulu' })
  })

  it('installs, reports progress, persists the ID across managers, and removes only the managed folder', async () => {
    const args = { userData: root, platform, arch, home: root, env: {}, request: fakeTemurin() }
    const runtimes = createRuntimes(args)
    const available = await runtimes.available('temurin', 17)
    expect(available).toMatchObject({ version: '17.0.21.1+2', licenseUrl: expect.stringContaining('https://') })
    expect(available).not.toHaveProperty('url')
    const progress = []
    const installed = await runtimes.install('temurin', 17, value => progress.push(value))
    expect(progress.map(value => value?.phase)).toEqual(expect.arrayContaining(['lookup', 'download', 'unpack']))
    expect(progress.at(-1)).toBeNull()
    const reopened = createRuntimes(args)
    expect(reopened.list()).toEqual([installed])
    expect(reopened.javaHomeOf(installed.id)).toBe(path.join(fs.realpathSync(root), 'runtimes', 'jdk', installed.id))
    expect(installed).toMatchObject({ managed: true, sizeBytes: release.length + 'fake-javafake-javac'.length })
    reopened.remove(installed.id)
    expect(reopened.javaHomeOf(installed.id)).toBeNull()
    expect(reopened.list()).toEqual([])
  })

  it('cancels before publishing and allows a clean retry', async () => {
    const runtimes = createRuntimes({ userData: root, platform, arch, home: root, env: {}, request: fakeTemurin() })
    const install = runtimes.install('temurin', 17, state => { if (state?.phase === 'unpack') runtimes.cancel() })
    await expect(install).rejects.toMatchObject({ name: 'AbortError' })
    expect(runtimes.list()).toEqual([])
    expect((await runtimes.install('temurin', 17)).managed).toBe(true)
  })

  it('does not create a managed directory through a link outside the app profile', async () => {
    const userData = path.join(root, 'profile')
    const outside = path.join(root, 'outside')
    fs.mkdirSync(userData)
    fs.mkdirSync(outside)
    fs.symlinkSync(outside, path.join(userData, 'runtimes'), process.platform === 'win32' ? 'junction' : 'dir')
    const runtimes = createRuntimes({ userData, platform, arch, home: root, env: {}, request: fakeTemurin() })
    await expect(runtimes.install('temurin', 17)).rejects.toThrow(/보관함 경로/)
    expect(fs.readdirSync(outside)).toEqual([])
  })

  it('estimates Maven, Gradle toolchains, legacy compatibility, and Spring Boot 3', async () => {
    expect(await requiredFeature(root)).toBeNull()
    put('pom.xml', '<project><properties><java.version>1.8</java.version><maven.compiler.release>${java.version}</maven.compiler.release></properties></project>')
    expect(await requiredFeature(root)).toBe(8)
    put('build.gradle', 'sourceCompatibility = JavaVersion.VERSION_11\n// languageVersion = JavaLanguageVersion.of(99)')
    expect(await requiredFeature(root)).toBe(11)
    put('build.gradle.kts', 'plugins { id("org.springframework.boot") version "3.5.1" }')
    expect(await requiredFeature(root)).toBe(17)
    put('build.gradle.kts', 'java { toolchain { languageVersion.set(JavaLanguageVersion.of(21)) } }')
    expect(await requiredFeature(root)).toBe(21)
    fs.unlinkSync(path.join(root, 'build.gradle.kts'))
    put('pom.xml', '<project><parent><groupId>org.springframework.boot</groupId><artifactId>spring-boot-starter-parent</artifactId><version>3.4.0</version></parent></project>')
    expect(await requiredFeature(root)).toBe(17)
  })

  it('reads only the fixed, small descriptors in the chosen directory', async () => {
    put('project/pom.xml', '<java.version>11</java.version>')
    put('project/build.gradle', 'sourceCompatibility = 22\n' + ' '.repeat(1024 * 1024))
    put('project/nested/build.gradle.kts', 'languageVersion.set(JavaLanguageVersion.of(23))')
    put('project/unlisted.xml', '<java.version>24</java.version>')
    const outside = put('outside/build.gradle.kts', 'languageVersion.set(JavaLanguageVersion.of(25))')
    const project = path.join(root, 'project')
    const linked = path.join(project, 'build.gradle.kts')
    try { fs.symlinkSync(outside, linked, 'file') } catch (error) {
      if (process.platform !== 'win32' || !['EPERM', 'EACCES'].includes(error.code)) throw error
    }
    expect(await requiredFeature(project)).toBe(11)
  })

  it('returns neither provider info nor manages files for an unauthorized renderer', async () => {
    const handlers = new Map()
    const runtimes = { list: vi.fn(), available: vi.fn(), install: vi.fn(), cancel: vi.fn(), remove: vi.fn() }
    registerRuntimesIpc({ ipcMain: { handle: (channel, fn) => handlers.set(channel, fn) }, runtimes,
      canUse: () => false, openExternal: vi.fn() })
    expect(handlers.get('runtimes-list')({})).toEqual({ jdks: [] })
    expect(await handlers.get('runtimes-available')({}, 'zulu', 17)).toMatchObject({ jdk: null })
    expect(await handlers.get('runtimes-install')({}, 'zulu', 17)).toMatchObject({ ok: false })
    expect(handlers.get('runtimes-cancel')({})).toBe(false)
    expect(handlers.get('runtimes-remove')({}, 'some-id')).toMatchObject({ ok: false })
    for (const action of Object.values(runtimes)) expect(action).not.toHaveBeenCalled()
  })
})
