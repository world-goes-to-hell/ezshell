import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { zipOf } from '../../e2e/support/jdkFixture.js'
import { searchJars } from './jarSearch.js'

const entry = 'org/example/Driver$Proxy.class'
let root, projectRoot, home

beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ezshell-jar-search-')))
  projectRoot = path.join(root, 'project')
  home = path.join(root, 'home')
  fs.mkdirSync(projectRoot)
  fs.mkdirSync(home)
})
afterEach(() => {
  vi.useRealTimers()
  fs.rmSync(root, { recursive: true, force: true })
})

function file(relative, bytes) {
  const name = path.join(root, relative)
  fs.mkdirSync(path.dirname(name), { recursive: true })
  fs.writeFileSync(name, bytes)
  return name
}

const jar = (relative, entries = { [entry]: 'fixture' }) => file(relative, zipOf(entries))
const search = options => searchJars({ projectRoot, home, className: 'org.example.Driver$Proxy', ...options })

describe('local class lookup in JAR central directories', () => {
  it('returns all matches in project libraries, Eclipse lib entries, Maven, Gradle and a user folder', async () => {
    const project = jar('project/WebContent/WEB-INF/lib/connector-1.2.3.jar', {
      [entry]: 'fixture',
      'META-INF/maven/org.vendor/connector/pom.properties': 'unused payload'
    })
    const eclipse = jar('project/modules/example/third party/driver.jar')
    file('project/modules/example/.classpath', '<classpath><classpathentry kind="lib" path="third party/driver.jar"/></classpath>')
    const maven = jar('home/.m2/repository/org/example/demo/2.0/demo-2.0.jar')
    const gradle = jar(`home/.gradle/caches/modules-2/files-2.1/com.vendor/driver/4.1/${'a1'.repeat(20)}/driver-4.1.jar`)
    const picked = jar('chosen/deep/library.jar')
    jar('project/lib/not-it.jar', { 'org/example/Driver.class': 'outer class' })
    jar('project/elsewhere/not-on-classpath.jar')
    const result = await search({ folders: [path.join(root, 'chosen')] })
    expect(result).toMatchObject({ incomplete: false, scanned: 6 })
    expect(result.matches).toHaveLength(5)
    expect(result.matches).toEqual(expect.arrayContaining([
      { path: project, coordinate: 'org.vendor:connector:1.2.3' },
      { path: eclipse, coordinate: null },
      { path: maven, coordinate: 'org.example:demo:2.0' },
      { path: gradle, coordinate: 'com.vendor:driver:4.1' },
      { path: picked, coordinate: null }
    ]))
  })

  it('reads the exact central entry without opening the class data or treating nested classes as loadable', async () => {
    const bytes = zipOf({ [entry]: 'unreadable local header' })
    bytes.writeUInt32LE(0, 0)
    const target = file('project/lib/central-only.jar', bytes)
    jar('project/lib/boot.jar', { [`BOOT-INF/classes/${entry}`]: 'nested' })
    file('project/lib/truncated.jar', bytes.subarray(0, 28))
    expect(await search({ className: 'org/example/Driver$Proxy' })).toMatchObject({
      matches: [{ path: target, coordinate: null }], incomplete: false
    })
  })

  it('can compare UTF-8 class names and avoids guessing an ambiguous Maven coordinate', async () => {
    const target = jar('project/lib/demo-1.0.jar', {
      'org/example/한글.class': 'fixture',
      'META-INF/maven/org.old/demo/pom.properties': 'first',
      'META-INF/maven/org.new/demo/pom.properties': 'second'
    })
    expect((await search({ className: 'org.example.한글' })).matches).toEqual([{ path: target, coordinate: null }])
  })

  it('ignores linked directories and Eclipse paths outside the worktree', async () => {
    jar('outside/escape.jar')
    const link = path.join(projectRoot, 'lib')
    fs.symlinkSync(path.join(root, 'outside'), link, process.platform === 'win32' ? 'junction' : 'dir')
    const maven = jar('home/.m2/repository/org/example/demo/2.0/demo-2.0.jar')
    file('project/.classpath', '<classpath><classpathentry kind="lib" path="lib/escape.jar"/><classpathentry kind="lib" path="../outside/escape.jar"/><classpathentry kind="lib" path="../home/.m2/repository/org/example/demo/2.0/demo-2.0.jar"/></classpath>')
    const result = await search()
    expect(result.matches).toEqual([{ path: maven, coordinate: 'org.example:demo:2.0' }])
    expect(result.scanned).toBe(1)
  })

  it('marks partial results when an archive or traversal limit is reached', async () => {
    jar('project/lib/one.jar')
    jar('project/lib/two.jar')
    expect(await search({ limits: { maxFiles: 1 } })).toMatchObject({ incomplete: true, scanned: 1 })
    expect(await search({ limits: { maxJarBytes: 10 } })).toMatchObject({ incomplete: true, scanned: 2, matches: [] })
    expect(await search({ limits: { maxEntries: 1 } })).toMatchObject({ incomplete: true, scanned: 1 })
  })

  it('returns a partial result at the deadline and honors cancellation', async () => {
    vi.useFakeTimers()
    const expiring = search({ limits: { timeoutMs: 1 } })
    await vi.advanceTimersByTimeAsync(1)
    await expect(expiring).resolves.toMatchObject({ incomplete: true })
    vi.useRealTimers()
    const controller = new AbortController()
    const pending = search({ signal: controller.signal })
    controller.abort()
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
  })
})
