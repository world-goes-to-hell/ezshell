import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { createMavenPinSession, deleteMavenPin, exportMavenPin, inspectMavenPin } from './mavenPin.js'

const presetId = 'ac86ad87-3068-47bf-8621-5b16dc159738'
const jar = 'org/example/old/1.0/old-1.0.jar'
let root, userData, worktree
beforeEach(async () => {
  root = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), 'ezshell-maven-pin-'))
  userData = path.join(root, 'app profile')
  worktree = path.join(root, 'project')
  await Promise.all([userData, worktree].map(folder => fs.mkdir(folder)))
})
afterEach(async () => fs.rm(root, { recursive: true, force: true }))

const open = options => createMavenPinSession({ userData, presetId, ...options })
async function write(root, relative, data) {
  const file = path.join(root, relative)
  await fs.mkdir(path.dirname(file), { recursive: true })
  await fs.writeFile(file, data)
}

async function tracked(session, relative, data, repository = 'central') {
  await write(session.repository, relative, data)
  await fs.appendFile(path.join(session.repository, path.dirname(relative), '_remote.repositories'), `${path.basename(relative)}>${repository}=\r\n`)
}

describe('pinned Maven repositories', () => {
  it('publishes only remote releases from a successful run and prepares an independent file mirror', async () => {
    const session = await open()
    expect(session.args).toEqual([`-Dmaven.repo.local=${session.repository}`])
    await tracked(session, jar, 'artifact')
    await tracked(session, 'org/example/old/1.0/old-1.0.pom', 'POM')
    await tracked(session, 'org/example/plugin/2.1/plugin-2.1-metadata.xml', 'plugin descriptor')
    await tracked(session, 'org/example/local/2.0/local-2.0.jar', 'local build', '')
    await tracked(session, 'org/example/local/2.0/local-2.0.jar', 'local build overwrote a download')
    await tracked(session, 'org/example/snap/3.0-SNAPSHOT/snap-3.0-SNAPSHOT.jar', 'mutable')
    await write(session.repository, 'org/example/old/maven-metadata-central.xml', 'local metadata')
    const result = await session.finish(0)
    expect(result).toMatchObject({ status: 'pinned', artifacts: 3, skippedSnapshots: 1 })
    expect(await session.finish(1)).toEqual(result)
    expect(await fs.readFile(path.join(result.repository, jar), 'utf8')).toBe('artifact')
    expect((await fs.readFile(path.join(result.repository, `${jar}.sha1`), 'utf8')).trim()).toBe(createHash('sha1').update('artifact').digest('hex'))
    await expect(fs.stat(path.join(result.repository, 'org/example/local'))).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(fs.stat(path.join(result.repository, 'org/example/snap'))).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(fs.stat(session.repository)).rejects.toMatchObject({ code: 'ENOENT' })
    const replay = await open({ mode: 'replay' })
    expect(replay.args).toEqual([`-Dmaven.repo.local=${replay.repository}`, '-s', replay.replay.mirrorSettings, '-gs', replay.replay.globalSettings])
    expect(await fs.readFile(replay.replay.mirrorSettings, 'utf8')).toContain(`<mirrorOf>*</mirrorOf><url>${replay.replay.url}</url>`)
    expect(await fs.readFile(path.join(fileURLToPath(replay.replay.url), jar), 'utf8')).toBe('artifact')
    await replay.finish(0)
    await expect(fs.stat(replay.repository)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('keeps the last successful result after build failure, a size limit or an empty repository', async () => {
    const good = await open()
    await tracked(good, jar, 'artifact')
    const committed = await good.finish(0)
    const failed = await open()
    await tracked(failed, jar, 'failed build')
    expect(await failed.finish(1)).toEqual({ status: 'skipped' })
    const large = await open({ maxBytes: 4 })
    await tracked(large, jar, 'too large')
    await expect(large.finish(0)).rejects.toThrow('용량 한도')
    const empty = await open()
    expect(await empty.finish(0)).toEqual({ status: 'empty', skippedSnapshots: 0 })
    const replay = await open({ mode: 'replay' })
    expect(await fs.readFile(path.join(fileURLToPath(replay.replay.url), jar), 'utf8')).toBe('artifact')
    await expect(fs.stat(committed.repository)).resolves.toBeDefined()
    await replay.finish(0)
  })

  it('keeps a running replay stable while two successful captures replace the same preset', async () => {
    const first = await open()
    await tracked(first, jar, 'first')
    const saved = await first.finish(0)
    const replay = await open({ mode: 'replay' })
    const [second, third] = await Promise.all([open(), open()])
    await Promise.all([tracked(second, jar, 'second'), tracked(third, jar, 'third')])
    await Promise.all([second.finish(0), third.finish(0)])
    const published = await open({ mode: 'replay' })
    expect(['second', 'third']).toContain(await fs.readFile(path.join(fileURLToPath(published.replay.url), jar), 'utf8'))
    expect(await fs.readFile(path.join(fileURLToPath(replay.replay.url), jar), 'utf8')).toBe('first')
    await expect(fs.stat(saved.repository)).rejects.toMatchObject({ code: 'ENOENT' })
    await Promise.all([replay.finish(0), published.finish(0)])
  })

  it('merges remote metadata for captured versions and plugin prefixes only', async () => {
    const capture = await open()
    await tracked(capture, jar, 'old')
    await tracked(capture, 'org/example/old/1.1/old-1.1.jar', 'new')
    await tracked(capture, 'org/example/extra/2.0/extra-2.0.jar', 'plugin')
    await write(capture.repository, 'org/example/old/maven-metadata-central.xml', '<metadata><versioning><latest>9.0</latest><release>1.0</release><versions><version>9.0</version><version>1.0</version></versions></versioning></metadata>')
    await write(capture.repository, 'org/example/old/maven-metadata-company.xml', '<metadata><versioning><versions><version>1.1</version></versions></versioning></metadata>')
    await write(capture.repository, 'org/example/maven-metadata-company.xml', '<metadata><plugins><plugin><prefix>old</prefix><artifactId>old</artifactId></plugin><plugin><prefix>other</prefix><artifactId>not-captured</artifactId></plugin></plugins></metadata>')
    await write(capture.repository, 'org/example/maven-metadata-local.xml', '<metadata><plugins><plugin><prefix>local</prefix><artifactId>extra</artifactId></plugin></plugins></metadata>')
    const snapshot = await capture.finish(0)
    expect(snapshot).toMatchObject({ status: 'pinned', artifacts: 3, metadata: 2 })
    const versions = await fs.readFile(path.join(snapshot.repository, 'org/example/old/maven-metadata.xml'), 'utf8')
    expect(versions).toContain('<release>1.0</release>')
    expect(versions).toContain('<versions><version>1.0</version><version>1.1</version></versions>')
    expect(versions).not.toContain('9.0')
    const prefixes = await fs.readFile(path.join(snapshot.repository, 'org/example/maven-metadata.xml'), 'utf8')
    expect(prefixes).toContain('<prefix>old</prefix><artifactId>old</artifactId>')
    expect(prefixes).not.toMatch(/not-captured|<prefix>local/)
    const replay = await open({ mode: 'replay' })
    expect(await fs.readFile(replay.replay.mirrorSettings, 'utf8')).toContain('<pluginGroup>org.example</pluginGroup>')
    await replay.finish(0)
  })

  it('reaps abandoned Maven scratch directories and leaves directories of live owners alone', async () => {
    const active = await open()
    const preset = path.dirname(path.dirname(active.repository))
    const owner = spawn(process.execPath, ['-e', ''], { windowsHide: true })
    await once(owner, 'exit')
    const dead = path.join(preset, `run-${owner.pid}-ABC123`)
    const unrelated = path.join(preset, 'some-user-folder')
    await Promise.all([fs.mkdir(dead), fs.mkdir(unrelated)])
    const later = await open()
    await expect(fs.stat(dead)).rejects.toMatchObject({ code: 'ENOENT' })
    expect((await fs.stat(active.repository)).isDirectory()).toBe(true)
    expect((await fs.stat(unrelated)).isDirectory()).toBe(true)
    await Promise.all([active.finish(1), later.finish(1)])
  })

  it('exports and deletes the profile snapshot only after their separate approvals', async () => {
    const capture = await open()
    await tracked(capture, jar, 'artifact')
    const pinned = await capture.finish(0)
    expect(await inspectMavenPin({ userData, presetId })).toBe(true)
    await expect(exportMavenPin({ userData, presetId, worktree })).rejects.toThrow('내보내기를 확인')
    const target = await exportMavenPin({ userData, presetId, worktree, approved: true })
    expect(target).toBe(path.join(worktree, '.mvn-repo'))
    expect(await fs.readFile(path.join(target, jar), 'utf8')).toBe('artifact')
    await expect(exportMavenPin({ userData, presetId, worktree, approved: true })).rejects.toThrow('이미 프로젝트에')
    await expect(deleteMavenPin({ userData, presetId })).rejects.toThrow('삭제를 확인')
    await deleteMavenPin({ userData, presetId, approved: true })
    expect(await inspectMavenPin({ userData, presetId })).toBe(false)
    await expect(fs.stat(pinned.repository)).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await fs.readFile(path.join(target, jar), 'utf8')).toBe('artifact')
  })
})
