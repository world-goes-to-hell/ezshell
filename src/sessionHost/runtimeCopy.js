// The runtime copy: what the session host (and the agents' helper scripts) run from, outside the install
// folder, so the installer can replace the app while they go on.
//
// Two folders under %LOCALAPPDATA%\ezShell Sessions:
//   runtime-<electron>-<node-pty>-<arch>  the app's exe (renamed), the few files it needs to run as Node,
//                                          and node-pty. Large (about 250 MB), made again only when
//                                          Electron or node-pty changes.
//   app-<hash>                            host.js and the agents' bundles (out/main/agent-runtime), small,
//                                          made again whenever they change.
// A folder is written under a temporary name and renamed when complete, so a half copy is never used.
//
// Must not change (docs/plan/2026-11-26-sessions-survive-update.md, "0단계 A 결과"): the installer ends
// every process whose path starts with the install folder's path (compared as text, without a separator)
// and, without PowerShell, every `ezShell.exe`. So the copy's exe has another name, and a copy whose path
// starts with the install folder's is refused.
const fs = require('node:fs')
const path = require('node:path')
const { createHash } = require('node:crypto')

const EXE_NAME = 'ezShell-sessions.exe'
const RUNTIME_FILES = ['ffmpeg.dll', 'icudtl.dat', 'snapshot_blob.bin', 'v8_context_snapshot.bin']
const BASE_NAME = 'ezShell Sessions'
const COMPLETE = 'complete.json'
// Old folders can still be named in the environment of agents started before an update
const KEEP_OLD_DAYS = 14

/** Whether `target` would be ended by the installer of the app installed in `installDir` */
function startsWithInstallFolder(target, installDir) {
  return path.resolve(target).toLowerCase().startsWith(path.resolve(installDir).toLowerCase())
}

/** Files of a folder, recursively, as paths relative to it */
async function filesOf(folder, fsp, relative = '') {
  const entries = await fsp.readdir(path.join(folder, relative), { withFileTypes: true })
  const files = []
  for (const entry of entries) {
    const child = path.join(relative, entry.name)
    if (entry.isDirectory()) files.push(...await filesOf(folder, fsp, child))
    else if (entry.isFile()) files.push(child)
  }
  return files
}

/**
 * Writes `items` ([{ from, to }], `to` relative) into `target` unless it is already complete there.
 * Sources inside app.asar are read and written: copyFile is not one of the calls Electron reads from it.
 */
async function ensureFolder(target, items, fsp, label) {
  try {
    const done = JSON.parse(await fsp.readFile(path.join(target, COMPLETE), 'utf8'))
    if (done?.label === label) {
      // Used now: kept from the clean-up of old folders
      const now = new Date()
      await fsp.utimes(path.join(target, COMPLETE), now, now).catch(() => {})
      return target
    }
  } catch { /* not there yet */ }
  const temporary = `${target}.tmp-${process.pid}-${Date.now()}`
  await fsp.mkdir(temporary, { recursive: true })
  try {
    for (const { from, to } of items) {
      const destination = path.join(temporary, to)
      await fsp.mkdir(path.dirname(destination), { recursive: true })
      if (from.includes(`.asar${path.sep}`)) await fsp.writeFile(destination, await fsp.readFile(from))
      else await fsp.copyFile(from, destination)
    }
    await fsp.writeFile(path.join(temporary, COMPLETE), JSON.stringify({ label }))
    // A half copy left by an earlier start that was ended meanwhile
    await fsp.rm(target, { recursive: true, force: true }).catch(() => {})
    await fsp.rename(temporary, target)
    return target
  } catch (error) {
    await fsp.rm(temporary, { recursive: true, force: true }).catch(() => {})
    throw error
  }
}

/** Folders of other versions not used for a while */
async function removeOld(base, keep, fsp, now = Date.now()) {
  let names = []
  try { names = await fsp.readdir(base) } catch { return }
  for (const name of names) {
    if (keep.includes(name)) continue
    const folder = path.join(base, name)
    try {
      const marker = await fsp.stat(path.join(folder, COMPLETE)).catch(() => null)
      const changed = marker?.mtimeMs ?? (await fsp.stat(folder)).mtimeMs
      if (now - changed > KEEP_OLD_DAYS * 24 * 60 * 60 * 1000) await fsp.rm(folder, { recursive: true, force: true })
    } catch { /* in use or gone */ }
  }
}

/**
 * @param {object} options
 * @param {boolean} options.packaged app.isPackaged
 * @param {string} options.execPath the app's exe
 * @param {string} options.mainDir out/main (inside app.asar when packaged)
 * @param {string} options.ptyDir node-pty's folder (app.asar.unpacked when packaged)
 * @param {string} options.localAppData %LOCALAPPDATA%
 * @returns {Promise<{ exe: string, appRoot: string, ptyDir: string, hostScript: string } | null>}
 */
async function prepareRuntime({ packaged, execPath, mainDir, ptyDir, localAppData, versions = process.versions, arch = process.arch, platform = process.platform, fsp = fs.promises }) {
  if (platform !== 'win32') return null
  const hostSource = path.join(mainDir, 'src', 'sessionHost', 'host.js')
  // Nothing installs over a development run: it runs where it is
  if (!packaged) return { exe: execPath, appRoot: mainDir, ptyDir, hostScript: hostSource }
  if (!localAppData || !path.isAbsolute(localAppData)) return null
  const installDir = path.dirname(execPath)
  const base = path.join(localAppData, BASE_NAME)
  if (startsWithInstallFolder(base, installDir)) return null

  const ptyVersion = JSON.parse(await fsp.readFile(path.join(ptyDir, 'package.json'), 'utf8')).version
  const runtimeName = `runtime-${versions.electron}-${ptyVersion}-${arch}`
  const ptyItems = []
  for (const part of ['lib', path.join('prebuilds', `win32-${arch}`), path.join('build', 'Release', 'conpty')]) {
    const files = await filesOf(path.join(ptyDir, part), fsp).catch(() => [])
    for (const file of files) ptyItems.push({ from: path.join(ptyDir, part, file), to: path.join('node-pty', part, file) })
  }
  ptyItems.push({ from: path.join(ptyDir, 'package.json'), to: path.join('node-pty', 'package.json') })
  const runtime = await ensureFolder(path.join(base, runtimeName), [
    { from: execPath, to: EXE_NAME },
    ...RUNTIME_FILES.map(file => ({ from: path.join(installDir, file), to: file })),
    ...ptyItems
  ], fsp, runtimeName)

  const agentFolder = path.join(mainDir, 'agent-runtime')
  const agentFiles = await filesOf(agentFolder, fsp).catch(() => [])
  const appItems = [
    { from: hostSource, to: 'host.js' },
    ...agentFiles.map(file => ({ from: path.join(agentFolder, file), to: path.join('agent-runtime', file) }))
  ]
  const hash = createHash('sha256')
  for (const item of appItems) hash.update(item.to).update('\0').update(await fsp.readFile(item.from))
  const appName = `app-${hash.digest('hex').slice(0, 16)}`
  const appRoot = await ensureFolder(path.join(base, appName), appItems, fsp, appName)

  void removeOld(base, [runtimeName, appName], fsp)
  return { exe: path.join(runtime, EXE_NAME), appRoot, ptyDir: path.join(runtime, 'node-pty'), hostScript: path.join(appRoot, 'host.js') }
}

/** Prepared once in the background; `current()` is null until it is ready (or when it failed) */
function createRuntimeCopy(options) {
  let current = null
  let preparing = null
  return {
    prepare() {
      preparing ??= prepareRuntime(options)
        .then(value => { current = value; return value })
        .catch(error => { console.error('[sessionHost] runtime copy failed:', error.code || error.message); return null })
      return preparing
    },
    current: () => current
  }
}

module.exports = { prepareRuntime, createRuntimeCopy, startsWithInstallFolder, EXE_NAME, BASE_NAME }
