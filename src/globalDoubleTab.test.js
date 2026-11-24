import { EventEmitter } from 'node:events'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { createGlobalDoubleTab, handleNumber, helperScript, overviewKeySpec } from './globalDoubleTab.js'

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

describe('the work overview shortcut from any program', () => {
  it('builds the helper only from numbers', () => {
    const script = helperScript(4321, 987654)
    expect(script).toContain('[EzShellDoubleTab]::Run(4321, 987654)')
    expect(script).toContain('SetWindowsHookEx(13')
    // The window in front is read before ezShell comes forward, in screen pixels
    expect(script).toContain('SetThreadDpiAwarenessContext')
    expect(script).not.toContain('${')
    // It goes on the command line (UTF-16 in base64), which Windows cuts at 32767 characters: keep room to grow
    expect(Buffer.from(helperScript(2 ** 31, Number.MAX_SAFE_INTEGER), 'utf16le').toString('base64').length).toBeLessThan(28000)
    expect(() => helperScript(4321, Number.NaN)).toThrow()
    expect(handleNumber(handle(987654))).toBe(987654)
    expect(handleNumber(Buffer.from([1, 0, 0, 0]))).toBe(1)
    expect(handleNumber('x')).toBe(0)
  })

  it('runs only on Windows, for a window it can name', () => {
    const { spawn } = fakeSpawn()
    expect(createGlobalDoubleTab({ onOverview: () => {}, platform: 'darwin', spawn }).start(handle(5))).toBe(false)
    expect(createGlobalDoubleTab({ onOverview: () => {}, platform: 'win32', spawn }).start(Buffer.alloc(8))).toBe(false)
    expect(spawn).not.toHaveBeenCalled()
  })

  it('tells the helper whether it is on and which keys, and passes on its "overview" only while on', () => {
    const { spawn, children } = fakeSpawn()
    const onOverview = vi.fn()
    const watch = createGlobalDoubleTab({ onOverview, platform: 'win32', spawn, env: { SystemRoot: 'C:\\Windows' } })
    expect(watch.start(handle(77), 1234)).toBe(true)
    const [child] = children
    expect(child.file).toBe('C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe')
    expect(Buffer.from(child.args.at(-1), 'base64').toString('utf16le')).toContain('Run(1234, 77)')

    // Ctrl+Alt+Space until the window says otherwise: Ctrl 1 + Alt 4, the space bar's virtual key
    child.stdout.emit('data', 'ready\r\n')
    expect(child.written).toEqual(['off\n', 'overview 5 32\n'])
    child.stdout.emit('data', 'overview\r\n')
    expect(onOverview).not.toHaveBeenCalled()

    watch.setEnabled(true)
    expect(child.written.at(-1)).toBe('on\n')
    child.stdout.emit('data', 'over')
    child.stdout.emit('data', 'view\r\n')
    expect(onOverview).toHaveBeenCalledTimes(1)
    expect(onOverview).toHaveBeenLastCalledWith(null)
    // Where the program in front was (the middle of its window, screen pixels): the overview opens on that monitor
    child.stdout.emit('data', 'overview -1280 540\r\n')
    expect(onOverview).toHaveBeenLastCalledWith({ x: -1280, y: 540 })
    // Anything else is not a point, and the old Tab Tab line means nothing
    child.stdout.emit('data', 'overview 1 2 3\r\noverview x 5\r\ndouble 10 20\r\n')
    expect(onOverview).toHaveBeenCalledTimes(2)

    watch.stop()
    expect(child.kill).toHaveBeenCalled()
  })

  it('sends the helper only the two numbers of a checked binding, again after a restart', () => {
    vi.useFakeTimers()
    try {
      const { spawn, children } = fakeSpawn()
      const watch = createGlobalDoubleTab({ onOverview: () => {}, platform: 'win32', spawn })
      watch.start(handle(9))
      children[0].stdout.emit('data', 'ready\r\n')
      watch.setOverviewKey(['Ctrl', 'Shift', 'O'])
      expect(children[0].written.at(-1)).toBe('overview 9 79\n')
      // A binding the rules refuse turns the shortcut off outside the window (the window's own stays)
      watch.setOverviewKey(['Ctrl', 'O'])
      expect(children[0].written.at(-1)).toBe('overview 0 0\n')
      watch.setOverviewKey('Ctrl+Alt+Space; on')
      expect(children[0].written.at(-1)).toBe('overview 0 0\n')
      watch.setOverviewKey(['Alt', 'Shift', 'F9'])
      children[0].emit('exit', 1)
      vi.advanceTimersByTime(3000)
      children[1].stdout.emit('data', 'ready\r\n')
      expect(children[1].written).toEqual(['off\n', 'overview 12 120\n'])
      watch.stop()
    } finally {
      vi.useRealTimers()
    }
  })

  it('turns a binding into modifier bits and a virtual key only under the rules for a key taken everywhere', () => {
    expect(overviewKeySpec(['Ctrl', 'Alt', 'Space'])).toEqual({ mods: 5, vk: 0x20 })
    expect(overviewKeySpec(['ctrl', 'shift', 'k'])).toEqual({ mods: 9, vk: 0x4b })
    expect(overviewKeySpec(['Ctrl', 'Alt', 'Shift', '7'])).toEqual({ mods: 13, vk: 0x37 })
    expect(overviewKeySpec(['Alt', 'Shift', 'F24'])).toEqual({ mods: 12, vk: 0x87 })
    expect(overviewKeySpec(['Ctrl', 'Alt', '`'])).toEqual({ mods: 5, vk: 0xc0 })
    expect(overviewKeySpec(['Ctrl', 'Alt', 'ArrowUp'])).toEqual({ mods: 5, vk: 0x26 })
    for (const keys of [
      ['Ctrl', 'Space'], ['Alt', 'B'], ['Shift', 'F5'], ['Ctrl', 'Alt'], ['Shift', 'Alt'].slice(0, 1),
      ['Ctrl', 'Alt', 'Tab'], ['Ctrl', 'Alt', 'Enter'], ['Ctrl', 'Alt', 'Delete'], ['Win', 'Alt', 'Space'],
      ['Ctrl', 'Alt', 'Space', 'X'], ['Ctrl', 'Alt', 'F25'], ['Ctrl', 'Alt', 'é'], [], 'Ctrl+Alt+Space', null,
      ['Ctrl', 'Alt', 'x'.repeat(13)], ['Ctrl', 'Ctrl', 'Space'], ['Ctrl', 'Alt', 7],
      // Names of Object.prototype are not keys (security review)
      ['Ctrl', 'Alt', 'Space', 'constructor'], ['Ctrl', 'Alt', '__proto__'], ['Ctrl', 'Alt', 'toString']
    ]) expect(overviewKeySpec(keys)).toBeNull()
    // A list with a hole (sent from a broken window) is refused, not thrown on in main's IPC handler
    // eslint-disable-next-line no-sparse-arrays
    expect(overviewKeySpec(['Ctrl', , 'Alt', 'Space'])).toBeNull()
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

  it('forwards capture only while enabled and leaves the overview as a separate notification', () => {
    const { spawn, children } = fakeSpawn()
    const onCapture = vi.fn()
    const onCaptureCancel = vi.fn()
    const onOverview = vi.fn()
    const watch = createGlobalDoubleTab({ onCapture, onCaptureCancel, onOverview, platform: 'win32', spawn })
    watch.start(handle(9))
    const [child] = children
    child.stdout.emit('data', 'capture\r\ncapture-cancel\r\n')
    expect(onCapture).not.toHaveBeenCalled()
    expect(onCaptureCancel).not.toHaveBeenCalled()
    watch.setEnabled(true)
    child.stdout.emit('data', 'cap')
    child.stdout.emit('data', 'ture\r\ncapture-cancel 27\r\ncapture-cancel\r\noverview 10 20\r\n')
    expect(onCapture).toHaveBeenCalledTimes(1)
    expect(onCaptureCancel).toHaveBeenCalledTimes(1)
    expect(onCapture.mock.invocationCallOrder[0]).toBeLessThan(onCaptureCancel.mock.invocationCallOrder[0])
    expect(onOverview).toHaveBeenCalledWith({ x: 10, y: 20 })
    watch.focusCapture(Buffer.alloc(0))
    watch.focusCapture(handle(42))
    watch.endCapture()
    expect(child.written).toEqual(['on\n', 'capture-focus 42\n', 'capture-end\n'])
    watch.stop()
  })

  it.skipIf(process.platform !== 'win32')('compiles the native helper and recognizes the capture gesture and the overview keys', () => {
    const source = "$ProgressPreference = 'SilentlyContinue'\n" + helperScript(123, 456).split('\n[EzShellDoubleTab]::Run')[0]
    const script = source + String.raw`
$gesture = [EzShellDoubleTab].GetMethod('CaptureGesture', [Reflection.BindingFlags]'NonPublic,Static')
function G([int]$held, [bool]$modifier, [bool]$down) { [bool]$gesture.Invoke($null, @($held, $modifier, $down)) }
if ((G 1 $true $true) -or (G 3 $true $true) -or (G 7 $true $true) -or (G 5 $true $false)) { exit 1 }
if (!(G 0 $true $false) -or (G 0 $true $false)) { exit 2 }
G 2 $true $true
G 6 $true $true
G 7 $true $true
G 7 $false $true
if (G 0 $true $false) { exit 3 }
G 7 $true $true
G 15 $true $true
if (G 0 $true $false) { exit 4 }
if ((G 1 $true $true) -or (G 5 $true $true) -or (G 13 $true $true) -or (G 12 $true $false)) { exit 5 }
if (!(G 0 $true $false) -or (G 0 $true $false)) { exit 6 }
G 13 $true $true
G 13 $false $true
if (G 0 $true $false) { exit 7 }
$flags = [Reflection.BindingFlags]'NonPublic,Static'
$escape = [EzShellDoubleTab].GetMethod('CaptureEscape', $flags)
$state = [EzShellDoubleTab].GetField('captureState', $flags)
$captureWindow = [EzShellDoubleTab].GetField('captureWindow', $flags)
$modifiers = [EzShellDoubleTab].GetField('modifiers', $flags)
$messages = [EzShellDoubleTab].GetField('captureMessages', $flags).GetValue($null)
function E([bool]$down, [bool]$up, [long]$front = 0) {
  [bool]$escape.Invoke($null, @($down, $up, [IntPtr]::new($front)))
}
if ((E $true $false) -or $messages.Count -ne 0) { exit 8 }
$state.SetValue($null, 1)
$modifiers.SetValue($null, 7)
if ((E $true $false) -or $messages.Count -ne 0) { exit 9 }
$modifiers.SetValue($null, 0)
$captureWindow.SetValue($null, [long]42)
if ((E $true $false 42) -or (E $false $true 42) -or $messages.Count -ne 0) { exit 13 }
if (!(E $true $false) -or !(E $true $false) -or $messages.Count -ne 1) { exit 10 }
if ($messages.Take() -ne 'capture-cancel') { exit 11 }
$state.SetValue($null, 0)
if (!(E $false $true) -or (E $true $false)) { exit 12 }
$captureWindow.SetValue($null, [long]0)
$state.SetValue($null, 1)
if (!(E $true $false) -or !(E $false $true) -or $messages.Take() -ne 'capture-cancel') { exit 14 }
$set = [EzShellDoubleTab].GetMethod('SetOverview', $flags)
$chord = [EzShellDoubleTab].GetMethod('IsOverviewChord', $flags)
function C([int]$vk, [int]$held) { [bool]$chord.Invoke($null, @([uint32]$vk, $held)) }
# Ctrl+Alt+Space by default: that key with exactly those modifiers
if (!(C 32 5) -or (C 32 4) -or (C 32 13) -or (C 32 7) -or (C 9 5) -or (C 33 5)) { exit 20 }
$set.Invoke($null, @('9 79'))
if (!(C 79 9) -or (C 32 5)) { exit 21 }
# The helper checks the numbers too: one modifier, the Windows key, a key not in its table, junk: off
foreach ($bad in @('1 79', '8 79', '3 79', '7 32', '5 9', '5 13', '5 300', '5', 'x y', '-5 32', '5 32 1', '')) {
  $set.Invoke($null, @('9 79'))
  $set.Invoke($null, @($bad))
  if ((C 79 9) -or (C 32 5)) { exit 22 }
}
$set.Invoke($null, @('12 120'))
if (!(C 120 12)) { exit 23 }
# The held key: its repeats and release are kept, a press after a missed release (1.5 s silence) is not
$keep = [EzShellDoubleTab].GetMethod('KeepHeldKey', $flags)
$held = [EzShellDoubleTab].GetField('overviewHeld', $flags)
$heldAt = [EzShellDoubleTab].GetField('overviewHeldAt', $flags)
function K([bool]$down, [bool]$up, [long]$now) { [bool]$keep.Invoke($null, @($down, $up, $now)) }
$held.SetValue($null, [uint32]32)
$heldAt.SetValue($null, [long]1000)
if (!(K $true $false 1100) -or !(K $true $false 2500) -or $held.GetValue($null) -ne 32) { exit 24 }
if (!(K $false $true 2550) -or $held.GetValue($null) -ne 0) { exit 25 }
$held.SetValue($null, [uint32]32)
$heldAt.SetValue($null, [long]1000)
if ((K $true $false 2600) -or $held.GetValue($null) -ne 0) { exit 26 }
# A chord left waiting more than 5 s does not bring ezShell forward later
$waiting = [EzShellDoubleTab].GetMethod('FrontStillWaiting', $flags)
[EzShellDoubleTab].GetField('overviewFrontAt', $flags).SetValue($null, [long]1000)
if (!$waiting.Invoke($null, @([long]6000)) -or $waiting.Invoke($null, @([long]6001))) { exit 27 }
# A new binding or "off" lets go of a held key
$held.SetValue($null, [uint32]32)
$set.Invoke($null, @('5 32'))
if ($held.GetValue($null) -ne 0) { exit 28 }
`
    const powershell = `${process.env.SystemRoot ?? 'C:\\Windows'}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`
    // From a file: with these checks the script is longer than a command line may be
    const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'ezshell-hook-test-'))
    const file = path.join(folder, 'hook-test.ps1')
    try {
      fs.writeFileSync(file, '﻿' + script)
      execFileSync(powershell, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', file], {
        windowsHide: true, timeout: 10000, stdio: ['ignore', 'pipe', 'pipe']
      })
    } finally {
      fs.rmSync(folder, { recursive: true, force: true })
    }
  }, 12000)
})
