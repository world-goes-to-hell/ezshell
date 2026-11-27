import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createSessionHost } from './host.js'
import { createSessionHostClient, STATE_FILE, DEV_STATE_FILE } from './client.js'

const until = async (check, ms = 3000) => {
  for (const end = Date.now() + ms; Date.now() < end; await new Promise(resolve => setTimeout(resolve, 10))) if (check()) return
  throw new Error('timed out')
}

function fakePty(pid) {
  const pty = new EventEmitter()
  Object.assign(pty, { pid, written: [], killed: false })
  pty.onData = cb => pty.on('data', cb)
  pty.onExit = cb => pty.on('exit', cb)
  pty.write = text => pty.written.push(text)
  pty.resize = () => {}
  pty.kill = () => { pty.killed = true }
  return pty
}

// The host in this process, started where the client would start the real one
function startHosts(hosts, ptys) {
  return (_exe, _args, options) => {
    const server = net.createServer()
    const host = createSessionHost({
      spawn: () => { const pty = fakePty(500 + ptys.length); ptys.push(pty); return pty },
      token: options.env.EZSHELL_SESSIONS_TOKEN,
      killTree: () => {},
      exit: () => { host.exited = true; server.close() }
    })
    server.on('connection', socket => host.connection(socket))
    server.listen(options.env.EZSHELL_SESSIONS_PIPE)
    hosts.push({ host, server, env: options.env })
    const child = new EventEmitter()
    child.unref = () => {}
    child.pid = 4242
    return child
  }
}

describe.skipIf(process.platform !== 'win32')('the app and its session host', () => {
  let folder, hosts, ptys
  beforeEach(() => {
    folder = fs.mkdtempSync(path.join(os.tmpdir(), 'ezshell-host-client-'))
    hosts = []
    ptys = []
  })
  afterEach(() => {
    for (const { server } of hosts) server.close()
    fs.rmSync(folder, { recursive: true, force: true })
  })

  const runtime = () => ({ exe: 'C:\\copy\\ezShell-sessions.exe', ptyDir: 'C:\\copy\\node-pty', hostScript: 'C:\\copy\\app\\host.js' })
  const client = () => createSessionHostClient({ stateFolder: folder, runtime, spawn: startHosts(hosts, ptys), env: { PATH: 'C:\\Windows' } })
  const options = { name: 'xterm-256color', cols: 80, rows: 24, cwd: 'C:\\Users\\me', env: { PATH: 'C:\\Windows' } }

  it('starts the host with a fresh pipe and token, and runs shells there', async () => {
    const app = client()
    expect(await app.start()).toBe(true)
    expect(hosts).toHaveLength(1)
    expect(hosts[0].env).toMatchObject({ ELECTRON_RUN_AS_NODE: '1', EZSHELL_SESSIONS_PTY: 'C:\\copy\\node-pty' })
    expect(hosts[0].env.EZSHELL_SESSIONS_PIPE).toMatch(/^\\\\\.\\pipe\\ezshell-sessions-[0-9a-f]{32}$/)
    const pty = app.spawn('local:1', 'powershell.exe', [], options, { agent: null })
    const output = []
    pty.onData(data => output.push(data))
    await until(() => pty.pid === 500)
    pty.write('dir\r')
    await until(() => ptys[0].written.length === 1)
    ptys[0].emit('data', 'listing')
    await until(() => output.includes('listing'))
  })

  it('gives the shells to the next app after keep, and the next app takes them back', async () => {
    const first = client()
    await first.start()
    first.spawn('local:3', 'powershell.exe', [], options, { agent: 'claude', cwd: 'C:\\work' })
    await until(() => ptys.length === 1)
    first.setLayout([{ tabId: 'local:3', mainShellId: 'local:3', panes: {} }])
    expect(await first.keep(120000)).toBe(true)
    first.release()
    await new Promise(resolve => setTimeout(resolve, 50))
    ptys[0].emit('data', 'still running')
    expect(hosts[0].host.exited).toBeUndefined()

    const next = client()
    expect(await next.start()).toBe(true)
    expect(hosts).toHaveLength(1)
    const [kept] = next.takeAdoptable()
    expect(kept).toMatchObject({ id: 'local:3', pid: 500, meta: { agent: 'claude', cwd: 'C:\\work' } })
    expect(kept.buffer).toContain('still running')
    expect(next.takeAdoptable()).toEqual([])
    expect(next.takeKeptLayout()).toEqual([{ tabId: 'local:3', mainShellId: 'local:3', panes: {} }])
    expect(next.takeKeptLayout()).toBeNull()
    const pty = next.adopt(kept)
    expect(pty.pid).toBe(500)
    pty.write('more\r')
    await until(() => ptys[0].written.includes('more\r'))
  })

  it('ends the host on a quit, and the next app starts a new one', async () => {
    const first = client()
    await first.start()
    first.spawn('local:1', 'powershell.exe', [], options)
    await until(() => ptys.length === 1)
    first.shutdown()
    await until(() => hosts[0].host.exited === true)
    expect(ptys[0].killed).toBe(true)
    expect(fs.existsSync(path.join(folder, STATE_FILE))).toBe(false)
    const next = client()
    await next.start()
    expect(hosts).toHaveLength(2)
    expect(next.takeAdoptable()).toEqual([])
  })

  it('keeps shells in the app when there is no runtime copy', async () => {
    const app = createSessionHostClient({ stateFolder: folder, runtime: () => null, spawn: startHosts(hosts, ptys) })
    expect(await app.start()).toBe(false)
    expect(app.ready()).toBe(false)
  })

  it('ends the shells of a host that went away', async () => {
    const app = client()
    await app.start()
    const pty = app.spawn('local:1', 'powershell.exe', [], options)
    const exits = []
    pty.onExit(event => exits.push(event))
    await until(() => ptys.length === 1)
    hosts[0].host.endAll()
    await until(() => exits.length === 1)
    expect(app.ready()).toBe(false)
  })

  it('a second app does not take the shells of one still working: it starts its own host', async () => {
    const first = client()
    await first.start()
    first.spawn('local:1', 'powershell.exe', [], options)
    await until(() => ptys.length === 1)
    const second = client()
    expect(await second.start()).toBe(true)
    expect(hosts).toHaveLength(2)
    expect(second.ready()).toBe(true)
    expect(second.takeAdoptable()).toEqual([])
    // The first app still owns its host and shell
    expect(first.ready()).toBe(true)
    expect(ptys[0].killed).toBe(false)
  })

  it('a dev run keeps its own state file, apart from the installed app', async () => {
    const installed = client()
    await installed.start()
    const dev = createSessionHostClient({ stateFolder: folder, runtime, stateName: DEV_STATE_FILE, spawn: startHosts(hosts, ptys), env: { PATH: 'C:\\Windows' } })
    expect(await dev.start()).toBe(true)
    expect(hosts).toHaveLength(2)
    expect(fs.existsSync(path.join(folder, STATE_FILE))).toBe(true)
    expect(fs.existsSync(path.join(folder, DEV_STATE_FILE))).toBe(true)
    dev.shutdown()
    // The dev run's quit leaves the installed app's state for its next start
    expect(fs.existsSync(path.join(folder, STATE_FILE))).toBe(true)
    expect(installed.ready()).toBe(true)
  })
})
