import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createGlobalPointer, checkCursorSet, cursorFile, pngSize, helperScript, SYSTEM_CURSOR_IDS, HELPER_SOURCE } from './globalPointer.js'

/** A PNG head of the given size (enough for the IHDR check) */
function png(width, height = width) {
  const data = Buffer.alloc(33)
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(data, 0)
  data.writeUInt32BE(13, 8)
  data.write('IHDR', 12, 'latin1')
  data.writeUInt32BE(width, 16)
  data.writeUInt32BE(height, 20)
  return data
}
const cursor = (state, size = 48, hotspot = [2, 3]) => ({ state, png: png(size).toString('base64'), hotspot })

describe('checking the pointers the window sends', () => {
  it('takes known states with a PNG of the chosen size and a hotspot inside it', () => {
    const checked = checkCursorSet({ size: 48, cursors: [cursor('default'), cursor('pointer', 48, [47, 0])] })
    expect(checked.size).toBe(48)
    expect(checked.cursors.map(c => c.state)).toEqual(['default', 'pointer'])
    expect(pngSize(checked.cursors[0].png)).toEqual({ width: 48, height: 48 })
  })

  it.each([
    ['an unknown size', { size: 40, cursors: [cursor('default', 40)] }],
    ['a state without a system pointer', { size: 48, cursors: [cursor('grab')] }],
    ['an inherited name', { size: 48, cursors: [cursor('constructor')] }],
    ['the same state twice', { size: 48, cursors: [cursor('default'), cursor('default')] }],
    ['a PNG of another size', { size: 48, cursors: [cursor('default', 64)] }],
    ['a hotspot outside the image', { size: 48, cursors: [cursor('default', 48, [48, 0])] }],
    ['a fractional hotspot', { size: 48, cursors: [cursor('default', 48, [1.5, 0])] }],
    ['something that is not a PNG', { size: 48, cursors: [{ state: 'default', png: Buffer.from('hello').toString('base64'), hotspot: [0, 0] }] }],
    ['text that is not base64', { size: 48, cursors: [{ state: 'default', png: '../../x', hotspot: [0, 0] }] }],
    ['no cursors', { size: 48, cursors: [] }]
  ])('refuses %s', (_name, request) => {
    expect(checkCursorSet(request)).toBeNull()
  })

  it('maps the app states to the system pointer ids', () => {
    expect(SYSTEM_CURSOR_IDS).toMatchObject({ default: 32512, text: 32513, pointer: 32649, 'not-allowed': 32648, 'col-resize': 32644 })
    expect(Object.hasOwn(SYSTEM_CURSOR_IDS, 'grab')).toBe(false)
  })
})

describe('the .cur file', () => {
  it('is a one-entry cursor directory holding the PNG and its hotspot', () => {
    const image = png(64)
    const file = cursorFile(image, 64, [5, 9])
    expect(file.readUInt16LE(2)).toBe(2)
    expect(file.readUInt16LE(4)).toBe(1)
    expect([file[6], file[7]]).toEqual([64, 64])
    expect([file.readUInt16LE(10), file.readUInt16LE(12)]).toEqual([5, 9])
    expect(file.readUInt32LE(14)).toBe(image.length)
    expect(file.subarray(file.readUInt32LE(18)).equals(image)).toBe(true)
  })
})

describe('putting pointers in place and back', () => {
  let folder
  beforeEach(() => { folder = fs.mkdtempSync(path.join(os.tmpdir(), 'ezshell-pointer-')) })
  afterEach(() => fs.rmSync(folder, { recursive: true, force: true }))

  it('writes the files and asks the helper for exactly those pointers', () => {
    const pointer = createGlobalPointer({ folder, platform: 'win32', allowNative: false })
    expect(pointer.apply({ size: 48, cursors: [cursor('default'), cursor('text')] })).toBe(true)
    expect(fs.existsSync(path.join(folder, 'default.cur'))).toBe(true)
    expect(fs.existsSync(path.join(folder, 'text.cur'))).toBe(true)
    expect(pointer.sent).toEqual(['apply default=32512,text=32513'])
    pointer.restore()
    expect(pointer.sent.at(-1)).toBe('restore')
    expect(fs.existsSync(path.join(folder, 'applied'))).toBe(false)
  })

  it('does nothing for a refused request or another system', () => {
    const pointer = createGlobalPointer({ folder, platform: 'win32', allowNative: false })
    expect(pointer.apply({ size: 48, cursors: [cursor('grab')] })).toBe(false)
    const mac = createGlobalPointer({ folder, platform: 'darwin', allowNative: false })
    expect(mac.apply({ size: 48, cursors: [cursor('default')] })).toBe(false)
    expect([...pointer.sent, ...mac.sent]).toEqual([])
    expect(fs.readdirSync(folder)).toEqual([])
  })

  it('restores at the next start when a killed helper left them replaced, and only then', () => {
    const first = createGlobalPointer({ folder, platform: 'win32', allowNative: false })
    first.recover()
    expect(first.sent).toEqual([])
    first.apply({ size: 48, cursors: [cursor('default')] })
    const next = createGlobalPointer({ folder, platform: 'win32', allowNative: false })
    next.recover()
    expect(next.sent).toEqual(['restore'])
  })

  it('starts the helper once, sends after it is ready, and ends its input on quit', () => {
    const children = []
    const spawn = (file, args) => {
      const child = new EventEmitter()
      child.file = file
      child.args = args
      child.stdout = new EventEmitter()
      child.stdout.setEncoding = () => {}
      child.written = []
      child.ended = false
      child.stdin = Object.assign(new EventEmitter(), { write: text => child.written.push(text), end: () => { child.ended = true } })
      children.push(child)
      return child
    }
    const pointer = createGlobalPointer({ folder, platform: 'win32', spawn, env: { SystemRoot: 'C:\\Windows' } })
    pointer.apply({ size: 48, cursors: [cursor('default')] })
    pointer.apply({ size: 48, cursors: [cursor('pointer')] })
    expect(children).toHaveLength(1)
    expect(children[0].file).toBe('C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe')
    expect(children[0].written).toEqual([])
    children[0].stdout.emit('data', 'ready\n')
    expect(children[0].written).toEqual(['apply default=32512\n', 'apply pointer=32649\n'])
    pointer.stop()
    expect(children[0].ended).toBe(true)
  })

  it('puts the folder in the script as a quoted literal', () => {
    expect(helperScript("C:\\Users\\o'brien\\ezShell\\pointer")).toContain("[EzShellPointer]::Run('C:\\Users\\o''brien\\ezShell\\pointer')")
    expect(() => helperScript('relative\\folder')).toThrow()
    expect(() => helperScript('C:\\a\nb')).toThrow()
  })

  // Compiles only: running it would replace this PC's pointers
  it.skipIf(process.platform !== 'win32')('compiles the native helper', () => {
    const file = path.join(folder, 'compile.ps1')
    fs.writeFileSync(file, `$ErrorActionPreference = 'Stop'\nAdd-Type -TypeDefinition @'\n${HELPER_SOURCE}\n'@\nif ([EzShellPointer] -as [type]) { 'compiled' }\n`)
    const powershell = `${process.env.SystemRoot ?? 'C:\\Windows'}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`
    const output = execFileSync(powershell, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', file], { encoding: 'utf8', timeout: 60000 })
    expect(output.trim()).toBe('compiled')
  }, 70000)
})
