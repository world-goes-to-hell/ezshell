import { describe, it, expect, vi } from 'vitest'
import { createLocalShells, defaultShell, MAX_SHELLS, BACKLOG_CHARS } from './localShell.js'

function fakePty() {
  const pty = {
    write: vi.fn(),
    resize: vi.fn(),
    kill: vi.fn(),
    onData: (cb) => { pty.emit = cb },
    onExit: (cb) => { pty.exit = cb }
  }
  return pty
}

function setup() {
  const ptys = []
  const sent = []
  const spawn = vi.fn((file, args, options) => {
    const pty = fakePty()
    pty.options = options
    ptys.push(pty)
    return pty
  })
  const shells = createLocalShells({ spawn, send: (channel, payload) => sent.push({ channel, payload }), shell: { file: 'sh', args: [], name: 'sh' }, cwd: '/home', env: {} })
  return { shells, ptys, sent, spawn }
}

describe('defaultShell', () => {
  it('is PowerShell on Windows and the login shell elsewhere', () => {
    expect(defaultShell('win32', {}).file).toBe('powershell.exe')
    expect(defaultShell('linux', { SHELL: '/bin/zsh' })).toEqual({ file: '/bin/zsh', args: ['-l'], name: 'zsh' })
    expect(defaultShell('linux', {}).file).toBe('/bin/bash')
  })
})

describe('createLocalShells', () => {
  it('opens a shell with a clamped size and forwards its output', () => {
    const { shells, ptys, sent } = setup()
    const { id, name } = shells.open({ cols: 100000, rows: 'x' })
    expect(name).toBe('sh')
    expect(ptys[0].options).toMatchObject({ cols: 500, rows: 24, cwd: '/home' })
    ptys[0].emit('hello')
    expect(sent).toEqual([{ channel: 'local-shell-data', payload: { id, data: 'hello' } }])
  })

  it('gives a redrawn tab the output so far and the exit state', () => {
    const { shells, ptys } = setup()
    const { id } = shells.open()
    ptys[0].emit('a')
    ptys[0].emit('b')
    expect(shells.attach(id)).toEqual({ backlog: 'ab', exited: false, exitCode: null })
    ptys[0].exit({ exitCode: 3 })
    expect(shells.attach(id)).toEqual({ backlog: 'ab', exited: true, exitCode: 3 })
    expect(shells.attach('local:99')).toBeNull()
  })

  it('keeps only the end of a long output', () => {
    const { shells, ptys } = setup()
    const { id } = shells.open()
    for (let i = 0; i < 5; i++) ptys[0].emit(String(i).repeat(BACKLOG_CHARS))
    const { backlog } = shells.attach(id)
    expect(backlog.length).toBe(BACKLOG_CHARS)
    expect(backlog.endsWith('4')).toBe(true)
  })

  it('writes and resizes only a running shell, and ignores input that is not text', () => {
    const { shells, ptys } = setup()
    const { id } = shells.open()
    shells.write(id, 'ls\r')
    shells.write(id, { toString: () => 'x' })
    shells.write('local:99', 'x')
    shells.resize(id, 120, 40)
    expect(ptys[0].write.mock.calls).toEqual([['ls\r']])
    expect(ptys[0].resize).toHaveBeenCalledWith(120, 40)
    ptys[0].exit({ exitCode: 0 })
    shells.write(id, 'x')
    shells.resize(id, 80, 24)
    expect(ptys[0].write).toHaveBeenCalledTimes(1)
    expect(ptys[0].resize).toHaveBeenCalledTimes(1)
  })

  it('kills a running shell on close, and every shell on closeAll', () => {
    const { shells, ptys } = setup()
    const first = shells.open()
    shells.open()
    shells.open()
    ptys[2].exit({ exitCode: 0 })
    shells.close(first.id)
    expect(ptys[0].kill).toHaveBeenCalledTimes(1)
    shells.closeAll()
    expect(ptys[1].kill).toHaveBeenCalledTimes(1)
    expect(ptys[2].kill).not.toHaveBeenCalled()
    expect(shells.count()).toBe(0)
  })

  it('refuses more shells than the limit', () => {
    const { shells } = setup()
    for (let i = 0; i < MAX_SHELLS; i++) shells.open()
    expect(() => shells.open()).toThrow(/10개/)
  })
})
