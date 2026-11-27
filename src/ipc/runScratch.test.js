import { afterEach, beforeEach, expect, it } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { reapRunScratch, protectScratchOwner, ownerExited } from './runScratch.js'

let root
beforeEach(async () => { root = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), 'ezshell-reap-')) })
afterEach(async () => fs.rm(root, { recursive: true, force: true }))

it('reaps only recognized scratch directories whose owners exited', async () => {
  const departed = spawn(process.execPath, ['-e', ''], { windowsHide: true })
  await once(departed, 'exit')
  const preset = 'a1a729f9-0e10-4f7e-b510-8affbe1b2655'
  const profile = path.join(root, 'profile')
  const temp = path.join(root, 'tmp')
  const run = `run-${departed.pid}-abcdef`
  const doomed = [path.join(temp, `ezshell-javac-${departed.pid}-abcdef`),
    path.join(profile, 'runtimes', 'maven-pinned', preset, run),
    path.join(profile, 'runtimes', 'tomcat-base', preset, run),
    path.join(profile, 'runtimes', 'maven-settings', `.run-${preset}-${departed.pid}-abcdef`),
    path.join(profile, 'runtimes', 'tomcat-classes', preset, 'a'.repeat(64), `.build-${departed.pid}-abcdef`)]
  const retained = [path.join(temp, `ezshell-javac-${process.pid}-abcdef`), path.join(temp, 'ezshell-javac-abcdef'),
    path.join(profile, 'runtimes', 'maven-pinned', preset, 'repo-keep'),
    path.join(profile, 'runtimes', 'tomcat-base', 'foreign-name', run), path.join(root, 'outside')]
  for (const target of [...doomed, ...retained]) await fs.mkdir(target, { recursive: true })
  const link = path.join(temp, `ezshell-javac-${departed.pid}-aabbcc`)
  await fs.symlink(retained.at(-1), link, 'junction')
  await reapRunScratch(profile, temp)
  for (const target of doomed) await expect(fs.lstat(target)).rejects.toMatchObject({ code: 'ENOENT' })
  for (const target of retained) expect((await fs.stat(target)).isDirectory()).toBe(true)
  expect((await fs.lstat(link)).isSymbolicLink()).toBe(true)
})

// docs/plan/2026-11-27-run-presets-survive-update.md: a server the app before an update started still uses the
// folders named after that app's (exited) pid until it ends
it('keeps the scratch of an owner a handed-over run still uses, and reaps it once released', async () => {
  const departed = spawn(process.execPath, ['-e', ''], { windowsHide: true })
  await once(departed, 'exit')
  const preset = 'a1a729f9-0e10-4f7e-b510-8affbe1b2655'
  const profile = path.join(root, 'profile')
  const base = path.join(profile, 'runtimes', 'tomcat-base', preset, `run-${departed.pid}-abcdef`)
  await fs.mkdir(base, { recursive: true })
  const first = protectScratchOwner(departed.pid)
  const second = protectScratchOwner(departed.pid)
  expect(ownerExited(departed.pid)).toBe(false)
  await reapRunScratch(profile, path.join(root, 'tmp'))
  expect((await fs.stat(base)).isDirectory()).toBe(true)
  first()
  first()
  await reapRunScratch(profile, path.join(root, 'tmp'))
  expect((await fs.stat(base)).isDirectory()).toBe(true)
  second()
  expect(ownerExited(departed.pid)).toBe(true)
  await reapRunScratch(profile, path.join(root, 'tmp'))
  await expect(fs.lstat(base)).rejects.toMatchObject({ code: 'ENOENT' })
  expect(protectScratchOwner(0)).toBeTypeOf('function')
})
