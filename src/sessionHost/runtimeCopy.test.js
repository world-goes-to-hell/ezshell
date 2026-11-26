import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { prepareRuntime, startsWithInstallFolder, EXE_NAME, BASE_NAME } from './runtimeCopy.js'

function write(file, text = 'x') {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, text)
}

describe('the runtime copy', () => {
  let root, install, mainDir, ptyDir, local
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'ezshell-runtime-'))
    install = path.join(root, 'Programs', 'ezShell')
    local = path.join(root, 'Local')
    mainDir = path.join(install, 'resources', 'app', 'out', 'main')
    ptyDir = path.join(install, 'resources', 'app.asar.unpacked', 'node_modules', 'node-pty')
    for (const file of ['ezShell.exe', 'ffmpeg.dll', 'icudtl.dat', 'snapshot_blob.bin', 'v8_context_snapshot.bin', 'd3dcompiler_47.dll']) write(path.join(install, file))
    write(path.join(ptyDir, 'package.json'), JSON.stringify({ version: '1.1.0' }))
    write(path.join(ptyDir, 'lib', 'index.js'))
    write(path.join(ptyDir, 'prebuilds', 'win32-x64', 'conpty.node'))
    write(path.join(ptyDir, 'prebuilds', 'darwin-arm64', 'pty.node'))
    write(path.join(ptyDir, 'build', 'Release', 'conpty', 'OpenConsole.exe'))
    write(path.join(mainDir, 'src', 'sessionHost', 'host.js'), 'host v1')
    write(path.join(mainDir, 'agent-runtime', 'agentHookReport.js'), 'hook v1')
  })
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }))

  const prepare = (extra = {}) => prepareRuntime({
    packaged: true, execPath: path.join(install, 'ezShell.exe'), mainDir, ptyDir, localAppData: local,
    versions: { electron: '45.3.3' }, arch: 'x64', platform: 'win32', ...extra
  })

  it('copies the exe under another name, the files to run as Node, node-pty for this system, and the scripts', async () => {
    const copy = await prepare()
    expect(path.basename(copy.exe)).toBe(EXE_NAME)
    expect(startsWithInstallFolder(copy.exe, install)).toBe(false)
    const runtime = path.dirname(copy.exe)
    expect(path.basename(runtime)).toBe('runtime-45.3.3-1.1.0-x64')
    expect(fs.existsSync(path.join(runtime, 'icudtl.dat'))).toBe(true)
    expect(fs.existsSync(path.join(runtime, 'd3dcompiler_47.dll'))).toBe(false)
    expect(fs.existsSync(path.join(copy.ptyDir, 'prebuilds', 'win32-x64', 'conpty.node'))).toBe(true)
    expect(fs.existsSync(path.join(copy.ptyDir, 'prebuilds', 'darwin-arm64'))).toBe(false)
    expect(fs.existsSync(path.join(copy.ptyDir, 'build', 'Release', 'conpty', 'OpenConsole.exe'))).toBe(true)
    expect(fs.readFileSync(copy.hostScript, 'utf8')).toBe('host v1')
    expect(fs.readFileSync(path.join(copy.appRoot, 'agent-runtime', 'agentHookReport.js'), 'utf8')).toBe('hook v1')
    expect(fs.readdirSync(path.join(local, BASE_NAME)).some(name => name.includes('.tmp-'))).toBe(false)
  })

  it('reuses a complete copy and makes a new script folder when a script changes', async () => {
    const first = await prepare()
    fs.writeFileSync(path.join(path.dirname(first.exe), EXE_NAME), 'marked')
    const again = await prepare()
    expect(again).toEqual(first)
    expect(fs.readFileSync(again.exe, 'utf8')).toBe('marked')
    write(path.join(mainDir, 'agent-runtime', 'agentHookReport.js'), 'hook v2')
    const changed = await prepare()
    expect(changed.exe).toBe(first.exe)
    expect(changed.appRoot).not.toBe(first.appRoot)
    // The earlier scripts stay for agents started with them
    expect(fs.existsSync(first.appRoot)).toBe(true)
  })

  it('names the exe the way localShell.js knows it (appRuntimes) when it looks for agent helpers', () => {
    expect(EXE_NAME.toLowerCase().replace(/\.exe$/, '')).toBe('ezshell-sessions')
    expect(fs.readFileSync(path.join(__dirname, '..', 'localShell.js'), 'utf8')).toContain("'ezshell-sessions'")
  })

  it('copies again over a folder left half done', async () => {
    const half = path.join(local, BASE_NAME, 'runtime-45.3.3-1.1.0-x64')
    write(path.join(half, EXE_NAME), 'half')
    const copy = await prepare()
    expect(fs.readFileSync(copy.exe, 'utf8')).toBe('x')
  })

  it('refuses a place the installer would end, as the folder text starts the same', async () => {
    expect(startsWithInstallFolder('C:\\Programs\\ezShell-runtime\\x.exe', 'C:\\Programs\\ezShell')).toBe(true)
    expect(startsWithInstallFolder('C:\\programs\\EZSHELL\\x.exe', 'C:\\Programs\\ezShell')).toBe(true)
    expect(startsWithInstallFolder('C:\\Local\\ezShell Sessions\\x.exe', 'C:\\Programs\\ezShell')).toBe(false)
    const installedInLocal = path.join(local, 'ezShell')
    write(path.join(installedInLocal, 'ezShell.exe'))
    expect(await prepare({ execPath: path.join(installedInLocal, 'ezShell.exe') })).toBeNull()
  })

  it('runs where it is in development, and not at all off Windows', async () => {
    expect(await prepare({ packaged: false })).toEqual({
      exe: path.join(install, 'ezShell.exe'), appRoot: mainDir, ptyDir, hostScript: path.join(mainDir, 'src', 'sessionHost', 'host.js')
    })
    expect(await prepare({ platform: 'darwin' })).toBeNull()
  })
})
