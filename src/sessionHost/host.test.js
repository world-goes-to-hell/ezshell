import { EventEmitter } from 'node:events'
import { describe, expect, it } from 'vitest'
import { createSessionHost, BUFFER_CHARS } from './host.js'

const TOKEN = 'a'.repeat(43)

function fakePty(pid) {
  const pty = { pid, written: [], resized: [], killed: false }
  const data = []
  const exits = []
  pty.onData = cb => data.push(cb)
  pty.onExit = cb => exits.push(cb)
  pty.write = text => pty.written.push(text)
  pty.resize = (cols, rows) => pty.resized.push([cols, rows])
  pty.kill = () => { pty.killed = true }
  pty.output = text => data.forEach(cb => cb(text))
  pty.end = code => exits.forEach(cb => cb({ exitCode: code }))
  return pty
}

function fakeSocket() {
  const socket = new EventEmitter()
  socket.sent = []
  socket.destroyed = false
  socket.write = text => { socket.sent.push(...text.trim().split('\n').map(line => JSON.parse(line))) }
  socket.destroy = () => { if (!socket.destroyed) { socket.destroyed = true; socket.emit('close') } }
  socket.say = message => socket.emit('data', JSON.stringify(message) + '\n')
  return socket
}

function setup() {
  let time = 1000
  const timers = []
  const ptys = []
  const killed = []
  let exited = 0
  const host = createSessionHost({
    spawn: () => { const pty = fakePty(100 + ptys.length); ptys.push(pty); return pty },
    token: TOKEN,
    killTree: pid => killed.push(pid),
    exit: () => { exited++ },
    now: () => time,
    setTimer: (fn, ms) => { const timer = { fn, at: time + ms, live: true }; timers.push(timer); return timer },
    clearTimer: timer => { if (timer) timer.live = false }
  })
  const advance = ms => {
    time += ms
    for (const timer of timers) if (timer.live && timer.at <= time) { timer.live = false; timer.fn() }
  }
  const connect = (token = TOKEN) => {
    const socket = fakeSocket()
    host.connection(socket)
    socket.say({ type: 'hello', token })
    return socket
  }
  return { host, ptys, killed, connect, advance, exits: () => exited }
}

const spawnRequest = (id = 'local:1', extra = {}) => ({
  type: 'spawn', id, file: 'powershell.exe', args: ['-NoLogo'],
  options: { name: 'xterm-256color', cols: 80, rows: 24, cwd: 'C:\\Users\\me', env: { PATH: 'C:\\Windows' } }, meta: { agent: 'claude' }, ...extra
})

describe('the session host', () => {
  it('lets in only a client whose hello carries the token', () => {
    const { connect, host } = setup()
    const stranger = connect('b'.repeat(43))
    expect(stranger.destroyed).toBe(true)
    const app = connect()
    expect(app.sent[0]).toMatchObject({ type: 'hello', format: 1 })
    expect(host.shells.size).toBe(0)
  })

  it('refuses anything before the hello', () => {
    const { host } = setup()
    const socket = fakeSocket()
    host.connection(socket)
    socket.say(spawnRequest())
    expect(socket.destroyed).toBe(true)
    expect(host.shells.size).toBe(0)
  })

  it('opens shells, passes keys and size, and sends their output and end', () => {
    const { connect, ptys } = setup()
    const app = connect()
    app.say(spawnRequest())
    expect(app.sent.at(-1)).toEqual({ type: 'spawned', id: 'local:1', pid: 100 })
    app.say({ type: 'write', id: 'local:1', data: 'dir\r' })
    app.say({ type: 'resize', id: 'local:1', cols: 120, rows: 40 })
    expect(ptys[0].written).toEqual(['dir\r'])
    expect(ptys[0].resized).toEqual([[120, 40]])
    ptys[0].output('hello')
    ptys[0].end(0)
    expect(app.sent.slice(-2)).toEqual([{ type: 'data', id: 'local:1', data: 'hello' }, { type: 'exit', id: 'local:1', exitCode: 0 }])
  })

  it.each([
    ['a relative folder', { options: { name: 'x', cols: 80, rows: 24, cwd: 'relative', env: {} } }],
    ['a size out of range', { options: { name: 'x', cols: 1, rows: 24, cwd: 'C:\\', env: {} } }],
    ['an env value that is not text', { options: { name: 'x', cols: 80, rows: 24, cwd: 'C:\\', env: { A: 1 } } }],
    ['an id with odd characters', { id: '../x' }],
    ['arguments that are not text', { args: [1] }]
  ])('refuses a spawn with %s', (_name, change) => {
    const { connect, ptys } = setup()
    const app = connect()
    app.say({ ...spawnRequest(), ...change })
    expect(app.sent.at(-1).type).toBe('spawn-error')
    expect(ptys).toHaveLength(0)
  })

  it('ends every shell with its tree when the app goes away without keep', () => {
    const { connect, ptys, killed, exits } = setup()
    const app = connect()
    app.say(spawnRequest('local:1'))
    app.say(spawnRequest('local:2'))
    app.destroy()
    expect(killed).toEqual([100, 101])
    expect(ptys.every(pty => pty.killed)).toBe(true)
    expect(exits()).toBe(1)
  })

  it('keeps the shells for the next app after keep, with what they printed meanwhile', () => {
    const { connect, ptys, killed, exits, advance } = setup()
    const app = connect()
    app.say(spawnRequest())
    app.say({ type: 'keep', ms: 120000 })
    app.destroy()
    ptys[0].output('built while away')
    advance(60000)
    expect(exits()).toBe(0)
    const next = connect()
    next.say({ type: 'list' })
    const [shell] = next.sent.at(-1).shells
    expect(shell).toMatchObject({ id: 'local:1', pid: 100, meta: { agent: 'claude' }, exited: false })
    expect(shell.buffer).toContain('built while away')
    advance(120000)
    expect(killed).toEqual([])
  })

  it('ends them when no app comes back in time', () => {
    const { connect, killed, exits, advance } = setup()
    const app = connect()
    app.say(spawnRequest())
    app.say({ type: 'keep', ms: 120000 })
    app.destroy()
    advance(120001)
    expect(killed).toEqual([100])
    expect(exits()).toBe(1)
  })

  it('caps keep at five minutes', () => {
    const { connect, exits, advance } = setup()
    const app = connect()
    app.say({ type: 'keep', ms: 60 * 60 * 1000 })
    app.destroy()
    advance(5 * 60 * 1000 + 1)
    expect(exits()).toBe(1)
  })

  it('ends by itself when the app never connects', () => {
    const { exits, advance } = setup()
    advance(30001)
    expect(exits()).toBe(1)
  })

  it('lets the newest app in and the old one go', () => {
    const { connect, exits } = setup()
    const first = connect()
    const second = connect()
    expect(first.destroyed).toBe(true)
    expect(second.destroyed).toBe(false)
    expect(exits()).toBe(0)
  })

  it('keeps only the last part of a long output', () => {
    const { connect, ptys } = setup()
    const app = connect()
    app.say(spawnRequest())
    ptys[0].output('x'.repeat(BUFFER_CHARS * 2 + 10))
    ptys[0].output('end')
    app.say({ type: 'list' })
    const [shell] = app.sent.at(-1).shells
    expect(shell.buffer.length).toBe(BUFFER_CHARS)
    expect(shell.buffer.endsWith('end')).toBe(true)
  })
})
