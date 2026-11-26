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
import { digest, fakeApache, fakeEnhanced, fakeGradleNode, fakeTemurin, fixtureRequest, jdkFiles, release, tomcatFiles, zipOf } from '../../e2e/support/jdkFixture.js'
import { unpackedGradleNodeHome } from './gradleNodeHome.js'

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

  it('allows only the exact additional JBR and HotswapAgent HTTPS hosts', () => {
    for (const host of ['api.github.com', 'cache-redirector.jetbrains.com', 'd2xrhe97vsfxuc.cloudfront.net']) {
      expect(approvedUrl(`https://${host}/file`)?.hostname).toBe(host)
      expect(approvedUrl(`https://${host}.invalid/file`)).toBeNull()
    }
    expect(approvedUrl('https://unrelated.cloudfront.net/file')).toBeNull()
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
    for (const { name, body = '', type = 'File', linkpath, mode = 0o755 } of entries) {
      const data = Buffer.from(body)
      const header = new Header({ path: name, size: data.length, mode, type, linkpath })
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

  it('accepts an identical repeated Maven TAR directory only for the Maven extraction option', async () => {
    const folder = { name: 'apache-maven-3.9.16/lib/jansi-native/', type: 'Directory' }
    const archive = put('maven.tar.gz', tarOf([folder, { name: `${folder.name}file`, body: 'fixture' }, folder]))
    const target = path.join(root, 'unpack')
    await expect(extractArchive(archive, target, 'tar.gz')).rejects.toThrow()
    await extractArchive(archive, target, 'tar.gz', undefined, { allowRepeatedDirectories: true })
    expect(fs.readFileSync(path.join(target, folder.name, 'file'), 'utf8')).toBe('fixture')
  })

  it.each([
    { name: 'apache-maven/lib/', type: 'Directory', mode: 0o777 },
    { name: 'apache-maven/Lib/', type: 'Directory' },
    { name: 'apache-maven/./lib/', type: 'Directory' },
    { name: 'apache-maven/lib', type: 'File' }
  ])('rejects ambiguous paths with Maven TAR directory deduplication enabled', async ambiguous => {
    const archive = put('ambiguous.tar.gz', tarOf([{ name: 'apache-maven/lib/', type: 'Directory' }, ambiguous]))
    const target = path.join(root, 'unpack')
    await expect(extractArchive(archive, target, 'tar.gz', undefined, { allowRepeatedDirectories: true })).rejects.toThrow()
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
    const runtimes = { list: vi.fn(), available: vi.fn(), install: vi.fn(), cancel: vi.fn(), remove: vi.fn(),
      hotswapAgentStatus: vi.fn(), installHotswapAgent: vi.fn(), removeHotswapAgent: vi.fn(),
      listTools: vi.fn(), toolAvailable: vi.fn(), installTool: vi.fn(), removeTool: vi.fn(), registerTomcat6: vi.fn() }
    const chooseTomcatFolder = vi.fn()
    registerRuntimesIpc({ ipcMain: { handle: (channel, fn) => handlers.set(channel, fn) }, runtimes,
      canUse: () => false, openExternal: vi.fn(), chooseTomcatFolder })
    expect(handlers.get('runtimes-list')({})).toEqual({ jdks: [], hotswapAgent: { installed: false }, tools: [] })
    expect(await handlers.get('runtimes-available')({}, 'zulu', 17)).toMatchObject({ jdk: null })
    expect(await handlers.get('runtimes-install')({}, 'zulu', 17)).toMatchObject({ ok: false })
    expect(handlers.get('runtimes-cancel')({})).toBe(false)
    expect(handlers.get('runtimes-remove')({}, 'some-id')).toMatchObject({ ok: false })
    expect(await handlers.get('runtimes-hotswap-install')({})).toMatchObject({ ok: false })
    expect(handlers.get('runtimes-hotswap-remove')({})).toMatchObject({ ok: false })
    expect(await handlers.get('runtimes-tool-available')({}, 'tomcat', '7')).toMatchObject({ tool: null })
    expect(await handlers.get('runtimes-tool-install')({}, 'tomcat', '7')).toMatchObject({ ok: false })
    expect(handlers.get('runtimes-tool-remove')({}, 'tomcat-7.0.109')).toMatchObject({ ok: false })
    expect(await handlers.get('runtimes-tomcat-register')({})).toMatchObject({ ok: false })
    expect(chooseTomcatFolder).not.toHaveBeenCalled()
    for (const action of Object.values(runtimes)) expect(action).not.toHaveBeenCalled()
  })
})

describe('Apache tools in the runtime library', () => {
  const manager = (request = fakeApache()) => createRuntimes({ userData: root, platform, arch, home: root, env: {}, request })

  it('checks SHA-512, publishes only a complete artifact, and removes only the app-owned tool', async () => {
    const runtimes = manager()
    const build = await runtimes.toolAvailable('tomcat', '7')
    expect(build).toMatchObject({ id: 'tomcat-7.0.109', tool: 'tomcat', series: '7' })
    expect(build).not.toHaveProperty('url')
    expect(build).not.toHaveProperty('sha512')
    const installed = await runtimes.installTool('tomcat', '7')
    const reopened = manager()
    expect(reopened.listTools()).toEqual([installed])
    expect(reopened.toolHomeOf(installed.id)).toBe(path.join(fs.realpathSync(root), 'runtimes', 'tools', installed.id, 'home'))
    reopened.removeTool(installed.id)
    expect(reopened.toolHomeOf(installed.id)).toBeNull()
    expect(reopened.listTools()).toEqual([])
    await expect(manager(fakeApache({ badChecksum: true })).installTool('tomcat', '7')).rejects.toThrow(/SHA-512/)
    expect(fs.readdirSync(path.join(root, 'runtimes', 'tools'))).toEqual([])
  })

  it('keeps registered Tomcat 6 usable across restarts without publishing or deleting its home', async () => {
    for (const [name, content] of Object.entries(tomcatFiles)) put(`legacy/${name}`, content)
    put('legacy/RELEASE-NOTES', 'Apache Tomcat Version 6.0.53\n')
    const runtimes = manager()
    const entry = runtimes.registerTomcat6(path.join(root, 'legacy'))
    expect(entry).toMatchObject({ tool: 'tomcat', series: '6', version: '6.0.53', managed: false, folder: 'legacy' })
    expect(entry).not.toHaveProperty('home')
    const reopened = manager()
    expect(reopened.listTools()).toEqual([entry])
    expect(reopened.toolHomeOf(entry.id)).toBe(path.join(fs.realpathSync(root), 'legacy'))
    expect(() => reopened.removeTool(entry.id)).toThrow(/받은 도구만/)
    await expect(reopened.installTool('tomcat', '6')).rejects.toThrow(/SHA-512/)
    expect(fs.existsSync(path.join(root, 'legacy', 'bin', 'bootstrap.jar'))).toBe(true)
  })

  it('rechecks the window lock after the Tomcat directory picker resolves', async () => {
    const handlers = new Map()
    let unlocked = true
    const runtimes = { registerTomcat6: vi.fn() }
    const pick = vi.fn(async () => { unlocked = false; return root })
    registerRuntimesIpc({ ipcMain: { handle: (channel, fn) => handlers.set(channel, fn) }, runtimes,
      canUse: () => unlocked, chooseTomcatFolder: pick })
    await expect(handlers.get('runtimes-tomcat-register')({})).resolves.toMatchObject({ ok: false })
    expect(pick).toHaveBeenCalledOnce()
    expect(runtimes.registerTomcat6).not.toHaveBeenCalled()
  })
})

describe('Gradle and Node.js in the runtime library', () => {
  it.each([['gradle', 'current', '9.9.2', 'bin/gradle.bat'], ['node', 'lts', '26.13.1', 'node.exe']])(
    'discovers %s, verifies its archive and removes only the managed installation', async (tool, series, version, executable) => {
      const local = put(`local/${executable}`, 'local executable')
      const env = tool === 'gradle' ? { GRADLE_HOME: path.join(root, 'local') } : { NODE_HOME: path.join(root, 'local') }
      const manager = (request = fakeGradleNode()) => createRuntimes({ userData: root, platform, arch, home: root, env, request })
      const runtimes = manager()
      const [found] = runtimes.listTools()
      expect(found).toMatchObject({ tool, managed: false, folder: 'local' })
      expect(found).not.toHaveProperty('home')
      const build = await runtimes.toolAvailable(tool, series)
      expect(build).toMatchObject({ id: `${tool}-${version}`, tool, series, version })
      expect(build).not.toHaveProperty('url')
      expect(build).not.toHaveProperty('sha256')
      expect(build).not.toHaveProperty('distributionFolder')
      await expect(manager(fakeGradleNode({ badChecksum: true })).installTool(tool, series)).rejects.toThrow(/SHA-256/)
      expect(runtimes.listTools()).toEqual([found])
      const installed = await runtimes.installTool(tool, series)
      const reopened = manager()
      expect(reopened.listTools()).toEqual([installed, found])
      expect(fs.readFileSync(path.join(reopened.toolHomeOf(installed.id), executable), 'utf8')).toContain('fake-')
      expect(() => reopened.removeTool(found.id)).toThrow(/받은 도구만/)
      reopened.removeTool(installed.id)
      expect(reopened.listTools()).toEqual([found])
      expect(fs.readFileSync(local, 'utf8')).toBe('local executable')
    })

  it.skipIf(process.platform === 'win32')('makes the extracted Unix Gradle launcher executable', () => {
    const file = put('gradle-9.9.2/bin/gradle', '#!/bin/sh\n')
    fs.chmodSync(file, 0o600)
    const home = unpackedGradleNodeHome(root, { tool: 'gradle', version: '9.9.2', distributionFolder: 'gradle-9.9.2' }, 'linux')
    expect(home).toBe(path.join(root, 'gradle-9.9.2'))
    expect(fs.statSync(file).mode & 0o111).toBe(0o111)
  })
})

describe('enhanced Java runtimes', () => {
  const manager = (request = fakeEnhanced()) => createRuntimes({ userData: root, platform, arch, home: root, env: {}, request })

  it('installs only eligible JBR SDKs and uses the separately managed agent for enhanced mode', async () => {
    const runtimes = manager()
    expect(await runtimes.available('jbr', 17)).toMatchObject({ feature: 17, version: '17.0.11+1163.125' })
    const available = await runtimes.available('jbr', 21)
    expect(available).toMatchObject({ vendor: 'jbr', version: '21.0.11+1163.125' })
    expect(available).not.toHaveProperty('url')
    expect(available).not.toHaveProperty('sha512')
    await expect(runtimes.available('jbr', 11)).rejects.toThrow()
    const jbr = await runtimes.install('jbr', 21)
    const temurin = await runtimes.install('temurin', 17)
    expect(jbr).toMatchObject({ vendor: 'jbr', managed: true, feature: 21 })
    expect(runtimes.enhancedJvmArgs(jbr.id)).toBeNull()

    await runtimes.installHotswapAgent()
    const reopened = manager()
    const jar = path.join(fs.realpathSync(root), 'runtimes', 'hotswap-agent', '2.0.5', 'hotswap-agent.jar')
    expect(reopened.hotswapAgentStatus()).toEqual({ installed: true, version: '2.0.5' })
    expect(reopened.enhancedJvmArgs(temurin.id)).toBeNull()
    expect(reopened.enhancedJvmArgs(jbr.id)).toEqual([
      '-XX:+AllowEnhancedClassRedefinition', '-XX:HotswapAgent=external', `-javaagent:${jar}`
    ])

    fs.writeFileSync(jar, 'agent-fixturE')
    expect(reopened.hotswapAgentStatus()).toEqual({ installed: false })
    expect(reopened.enhancedJvmArgs(jbr.id)).toBeNull()
    await reopened.installHotswapAgent()
    expect(reopened.hotswapAgentPath()).toBe(jar)
    reopened.removeHotswapAgent()
    expect(reopened.hotswapAgentStatus()).toEqual({ installed: false })
    expect(reopened.list()).toEqual([jbr, temurin])
  })

  it('does not publish a JBR or agent when its official checksum differs', async () => {
    const runtimes = manager(fakeEnhanced({ badJbrChecksum: true, badAgentDigest: true }))
    await expect(runtimes.install('jbr', 21)).rejects.toThrow(/SHA-512/)
    await expect(runtimes.installHotswapAgent()).rejects.toThrow(/SHA-256/)
    expect(runtimes.list()).toEqual([])
    expect(runtimes.hotswapAgentStatus()).toEqual({ installed: false })
    for (const kind of ['jdk', 'hotswap-agent']) expect(fs.readdirSync(path.join(root, 'runtimes', kind))).toEqual([])
  })
})
