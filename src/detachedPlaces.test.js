import { describe, it, expect, afterEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { placeFor, readPlaces, writePlace } from './detachedPlaces.js'

const SCREEN = [{ x: 0, y: 0, width: 1920, height: 1040 }]
const FALLBACK = { width: 900, height: 600 }
const MIN = { width: 600, height: 400 }
const place = (input) => placeFor({ workAreas: SCREEN, fallback: FALLBACK, min: MIN, ...input })

describe('placeFor', () => {
  it('uses the default size and no position when nothing is saved', () => {
    expect(place({ saved: undefined })).toEqual({ width: 900, height: 600, isMaximized: false })
  })

  it('opens where the last window of the kind was left', () => {
    expect(place({ saved: { x: 300, y: 120, width: 1000, height: 700, isMaximized: true } }))
      .toEqual({ x: 300, y: 120, width: 1000, height: 700, isMaximized: true })
  })

  it('accepts a size smaller than the main window allows, down to the kind\'s minimum', () => {
    expect(place({ saved: { x: 10, y: 10, width: 620, height: 420 } })).toMatchObject({ width: 620, height: 420 })
    expect(place({ saved: { x: 10, y: 10, width: 500, height: 420 } })).toEqual({ width: 900, height: 600, isMaximized: false })
  })

  it('falls back when the saved place is not on a connected screen', () => {
    expect(place({ saved: { x: 2500, y: 100, width: 900, height: 600 } })).toEqual({ width: 900, height: 600, isMaximized: false })
  })

  it('steps aside from open windows of the kind', () => {
    const saved = { x: 300, y: 120, width: 900, height: 600 }
    expect(place({ saved, others: [{ x: 300, y: 120 }] })).toMatchObject({ x: 330, y: 150 })
    expect(place({ saved, others: [{ x: 302, y: 121 }, { x: 330, y: 150 }] })).toMatchObject({ x: 360, y: 180 })
    expect(place({ saved, others: [{ x: 700, y: 500 }] })).toMatchObject({ x: 300, y: 120 })
  })

  it('stays on the saved place when stepping would leave the screen', () => {
    const saved = { x: 300, y: 920, width: 900, height: 600 }
    expect(place({ saved, others: [{ x: 300, y: 920 }] })).toMatchObject({ x: 300, y: 920 })
  })

  it('ignores a saved value that is not a place', () => {
    for (const saved of ['x', 5, null, [], { x: '1', y: 2, width: 900, height: 600 }]) {
      expect(place({ saved })).toEqual({ width: 900, height: 600, isMaximized: false })
    }
  })
})

describe('writePlace / readPlaces', () => {
  const file = path.join(os.tmpdir(), `ezshell-detached-${process.pid}.json`)
  afterEach(() => { try { fs.unlinkSync(file) } catch { /* not written */ } })

  it('keeps one place per kind', () => {
    writePlace(file, 'sftp', { x: 1, y: 2, width: 900, height: 600, isMaximized: false })
    writePlace(file, 'db', { x: 5, y: 6, width: 1180, height: 780, isMaximized: true })
    writePlace(file, 'sftp', { x: 9, y: 9, width: 950, height: 650, isMaximized: false })
    expect(readPlaces(file)).toEqual({
      sftp: { x: 9, y: 9, width: 950, height: 650, isMaximized: false },
      db: { x: 5, y: 6, width: 1180, height: 780, isMaximized: true }
    })
  })

  it('does not write an unknown kind and drops unknown keys already in the file', () => {
    fs.writeFileSync(file, JSON.stringify({ other: { x: 1 }, sftp: { x: 1, y: 1, width: 900, height: 600 } }))
    writePlace(file, '__proto__', { x: 0 })
    writePlace(file, 'terminal', { x: 3, y: 3, width: 800, height: 600, isMaximized: false })
    expect(Object.keys(readPlaces(file)).sort()).toEqual(['sftp', 'terminal'])
  })

  it('reads a missing or broken file as empty', () => {
    expect(readPlaces(file)).toEqual({})
    fs.writeFileSync(file, '[1,2')
    expect(readPlaces(file)).toEqual({})
  })
})
