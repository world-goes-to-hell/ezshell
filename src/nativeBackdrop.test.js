import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { readAppearance, writeAppearance, supportsAcrylic, backdropOptions, createFillToggle, FILE_NAME } from './nativeBackdrop.js'

let dir

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ezshell-backdrop-'))
})

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true })
})

describe('readAppearance / writeAppearance', () => {
  it('defaults to flat when nothing was saved or the file is broken', () => {
    expect(readAppearance(dir)).toEqual({ surface: 'flat', scheme: 'dark' })
    fs.writeFileSync(path.join(dir, FILE_NAME), '{not json')
    expect(readAppearance(dir)).toEqual({ surface: 'flat', scheme: 'dark' })
  })

  it('keeps the choice for the next start', () => {
    writeAppearance(dir, { surface: 'glass', scheme: 'light' })
    expect(readAppearance(dir)).toEqual({ surface: 'glass', scheme: 'light' })
  })

  it('writes only the two known fields, with known values', () => {
    writeAppearance(dir, { surface: 'acrylic', scheme: 'purple', backgroundMaterial: 'mica', path: 'C:\\x' })
    expect(JSON.parse(fs.readFileSync(path.join(dir, FILE_NAME), 'utf8'))).toEqual({ surface: 'flat', scheme: 'dark' })
    expect(writeAppearance(dir, null)).toEqual({ surface: 'flat', scheme: 'dark' })
  })
})

describe('supportsAcrylic', () => {
  it('needs Windows 11 22H2 or later', () => {
    expect(supportsAcrylic('win32', '10.0.22621')).toBe(true)
    expect(supportsAcrylic('win32', '10.0.26300')).toBe(true)
    expect(supportsAcrylic('win32', '10.0.22000')).toBe(false)
    expect(supportsAcrylic('win32', '10.0.19045')).toBe(false)
  })

  it('is off on other systems and for unreadable versions', () => {
    expect(supportsAcrylic('darwin', '23.1.0')).toBe(false)
    expect(supportsAcrylic('linux', '6.5.0')).toBe(false)
    expect(supportsAcrylic('win32', '')).toBe(false)
    expect(supportsAcrylic('win32', undefined)).toBe(false)
  })
})

describe('backdropOptions', () => {
  it('asks for acrylic only for glass on a Windows that can draw it', () => {
    expect(backdropOptions({ surface: 'glass' }, 'win32', '10.0.26300')).toEqual({ backgroundMaterial: 'acrylic', backgroundColor: '#00000000', maximizable: false })
    expect(backdropOptions({ surface: 'flat' }, 'win32', '10.0.26300')).toEqual({})
    expect(backdropOptions({ surface: 'glass' }, 'win32', '10.0.19045')).toEqual({})
    expect(backdropOptions({ surface: 'glass' }, 'darwin', '23.1.0')).toEqual({})
    expect(backdropOptions(undefined, 'win32', '10.0.26300')).toEqual({})
  })
})

describe('createFillToggle', () => {
  const workArea = { x: 0, y: 0, width: 2560, height: 1560 }
  const start = { x: 200, y: 150, width: 1200, height: 800 }
  const makeWindow = () => {
    let bounds = { ...start }
    return { getBounds: () => ({ ...bounds }), setBounds: next => { bounds = { ...next } } }
  }

  it('fills the work area and goes back to where the window was', () => {
    const win = makeWindow()
    const toggle = createFillToggle(win, () => workArea)
    expect(toggle.isFilled()).toBe(false)
    toggle.toggle()
    expect(win.getBounds()).toEqual(workArea)
    expect(toggle.isFilled()).toBe(true)
    expect(toggle.normalBounds()).toEqual(start)
    toggle.toggle()
    expect(win.getBounds()).toEqual(start)
    expect(toggle.isFilled()).toBe(false)
  })

  it('fills again after the user moved the filled window', () => {
    const win = makeWindow()
    const toggle = createFillToggle(win, () => workArea)
    toggle.toggle()
    const moved = { x: 40, y: 40, width: 900, height: 700 }
    win.setBounds(moved)
    expect(toggle.isFilled()).toBe(false)
    expect(toggle.normalBounds()).toEqual(moved)
    toggle.toggle()
    expect(win.getBounds()).toEqual(workArea)
    toggle.toggle()
    expect(win.getBounds()).toEqual(moved)
  })

  it('restores a saved maximized window with its saved normal size', () => {
    const win = makeWindow()
    const toggle = createFillToggle(win, () => workArea)
    toggle.fill(start)
    expect(win.getBounds()).toEqual(workArea)
    expect(toggle.normalBounds()).toEqual(start)
  })
})
