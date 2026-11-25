import { createRequire } from 'node:module'
import { describe, expect, it } from 'vitest'
import { CURSOR_STATES } from './pointerCursors'
import { DEFAULT_POINTER_PREFS } from './pointerPrefs'
import { pixelHotspot, SYSTEM_POINTER_STATES, systemPointerTarget } from './pointerSystem'

const require = createRequire(import.meta.url)
const { SYSTEM_CURSOR_IDS } = require('../../globalPointer.js')

describe('the pointer set in other programs', () => {
  it('sends exactly the states main can put in place', () => {
    expect([...SYSTEM_POINTER_STATES].sort()).toEqual(Object.keys(SYSTEM_CURSOR_IDS).sort())
    for (const state of SYSTEM_POINTER_STATES) expect(CURSOR_STATES).toContain(state)
  })

  it('replaces the system pointers only when switched on with a drawn set', () => {
    expect(systemPointerTarget({ ...DEFAULT_POINTER_PREFS, set: 'paw', size: 48 })).toBeNull()
    expect(systemPointerTarget({ ...DEFAULT_POINTER_PREFS, set: 'system', outsideApp: true })).toBeNull()
    expect(systemPointerTarget({ ...DEFAULT_POINTER_PREFS, set: 'paw', size: 48, outsideApp: true })).toEqual({ set: 'paw', size: 48 })
  })

  it('rounds a hotspot to a pixel inside the image', () => {
    expect(pixelHotspot([1.5, 13.4], 32)).toEqual([2, 13])
    expect(pixelHotspot([64, -1], 64)).toEqual([63, 0])
  })
})
