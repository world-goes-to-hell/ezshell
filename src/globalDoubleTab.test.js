import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
import { createGlobalDoubleTab, handleNumber, helperScript } from './globalDoubleTab.js'

function fakeSpawn() {
  const children = []
  const spawn = vi.fn((file, args) => {
    const child = new EventEmitter()
    child.file = file
    child.args = args
    child.stdout = new EventEmitter()
    child.stdout.setEncoding = () => {}
    child.written = []
    child.stdin = Object.assign(new EventEmitter(), { write: line => child.written.push(line), end: vi.fn() })
    child.kill = vi.fn()
    children.push(child)
    return child
  })
  return { spawn, children }
}

const handle = value => {
  const buffer = Buffer.alloc(8)
  buffer.writeBigUInt64LE(BigInt(value))
  return buffer
}

describe('Tab Tab from any program', () => {
  it('builds the helper only from numbers', () => {
    const script = helperScript(4321, 987654, 320)
    expect(script).toContain('[EzShellDoubleTab]::Run(4321, 987654, 320)')
    expect(script).toContain('SetWindowsHookEx(13')
    // The window in front is read before ezShell comes forward, in screen pixels
    expect(script).toContain('SetThreadDpiAwarenessContext')
    expect(script).not.toContain('${')
    expect(() => helperScript(4321, Number.NaN)).toThrow()
    expect(handleNumber(handle(987654))).toBe(987654)
    expect(handleNumber(Buffer.from([1, 0, 0, 0]))).toBe(1)
    expect(handleNumber('x')).toBe(0)
  })

  it('runs only on Windows, for a window it can name', () => {
    const { spawn } = fakeSpawn()
    expect(createGlobalDoubleTab({ onDoubleTab: () => {}, platform: 'darwin', spawn }).start(handle(5))).toBe(false)
    expect(createGlobalDoubleTab({ onDoubleTab: () => {}, platform: 'win32', spawn }).start(Buffer.alloc(8))).toBe(false)
    expect(spawn).not.toHaveBeenCalled()
  })

  it('tells the helper whether it is on, and passes on its "double" only while on', () => {
    const { spawn, children } = fakeSpawn()
    const onDoubleTab = vi.fn()
    const watch = createGlobalDoubleTab({ onDoubleTab, platform: 'win32', spawn, env: { SystemRoot: 'C:\\Windows' } })
    expect(watch.start(handle(77), 1234)).toBe(true)
    const [child] = children
    expect(child.file).toBe('C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe')
    expect(Buffer.from(child.args.at(-1), 'base64').toString('utf16le')).toContain('Run(1234, 77, 320)')

    child.stdout.emit('data', 'ready\r\n')
    expect(child.written).toEqual(['off\n'])
    child.stdout.emit('data', 'double\r\n')
    expect(onDoubleTab).not.toHaveBeenCalled()

    watch.setEnabled(true)
    expect(child.written.at(-1)).toBe('on\n')
    child.stdout.emit('data', 'dou')
    child.stdout.emit('data', 'ble\r\n')
    expect(onDoubleTab).toHaveBeenCalledTimes(1)
    expect(onDoubleTab).toHaveBeenLastCalledWith(null)
    // Where the program in front was (the middle of its window, screen pixels): the overview opens on that monitor
    child.stdout.emit('data', 'double -1280 540\r\n')
    expect(onDoubleTab).toHaveBeenLastCalledWith({ x: -1280, y: 540 })
    // Anything else is not a point
    child.stdout.emit('data', 'double 1 2 3\r\ndouble x 5\r\n')
    expect(onDoubleTab).toHaveBeenCalledTimes(2)

    watch.stop()
    expect(child.kill).toHaveBeenCalled()
  })

  it('starts the helper again when it ends by itself, a few times', () => {
    vi.useFakeTimers()
    try {
      const { spawn, children } = fakeSpawn()
      const watch = createGlobalDoubleTab({ onDoubleTab: () => {}, platform: 'win32', spawn })
      watch.start(handle(9))
      for (let round = 0; round < 5; round++) {
        children.at(-1).emit('exit', 1)
        vi.advanceTimersByTime(10_000)
      }
      expect(spawn).toHaveBeenCalledTimes(4)
      watch.stop()
    } finally {
      vi.useRealTimers()
    }
  })
})
