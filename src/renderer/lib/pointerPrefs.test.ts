import { describe, expect, it } from 'vitest'
import { DEFAULT_POINTER_PREFS, hasEffects, parsePointerPrefs } from './pointerPrefs'
import { CURSOR_SETS, CURSOR_STATES, cursorHotspot, cursorSet, cursorSvg, cursorValue } from './pointerCursors'
import { inkFor } from './pointerInk'
import { contrastRatio } from './colorContrast'
import { collectUiSettings, parseUiSettingsFile } from './uiSettingsBackup'

describe('pointer prefs', () => {
  it('starts with the system pointer and no effects', () => {
    expect(parsePointerPrefs(null)).toEqual(DEFAULT_POINTER_PREFS)
    expect(DEFAULT_POINTER_PREFS).toMatchObject({ set: 'system', size: 32, move: 'none', click: 'none', moveOnTerminal: false, clickOnTerminal: true, outsideApp: false, effectsOutsideApp: false })
    expect(hasEffects(DEFAULT_POINTER_PREFS)).toBe(false)
  })

  it('reads a stored value and falls back field by field on anything unknown', () => {
    const stored = { set: 'paw', size: 64, move: 'comet', click: 'word', moveLevel: 3, clickLevel: 1, moveOnTerminal: true, clickOnTerminal: false, outsideApp: false, effectsOutsideApp: true }
    expect(parsePointerPrefs(JSON.stringify(stored))).toEqual(stored)
    expect(parsePointerPrefs(JSON.stringify({ set: 'evil', size: 128, move: 'x', click: 7, moveLevel: 9, moveOnTerminal: 'yes', clickOnTerminal: false, outsideApp: 'yes', effectsOutsideApp: 1 })))
      .toEqual({ ...DEFAULT_POINTER_PREFS, clickOnTerminal: false })
    expect(parsePointerPrefs('{"outsideApp":true}')).toMatchObject({ outsideApp: true, effectsOutsideApp: false })
    for (const raw of ['', '{', '[]', '"paw"', 'null', '42']) expect(parsePointerPrefs(raw)).toEqual(DEFAULT_POINTER_PREFS)
    expect(hasEffects(parsePointerPrefs('{"click":"ripple"}'))).toBe(true)
  })

  it('travels in the screen settings backup as its checked form', () => {
    const value = JSON.stringify({ set: 'pixel', size: 48, move: 'pixel', click: 'press', effectsOutsideApp: true, extra: 'dropped' })
    const file = collectUiSettings(key => (key === 'pointerPrefs' ? value : null), { shortcutIds: [] }, new Date(0))
    expect(JSON.parse(file.settings.pointerPrefs!)).toEqual({ ...DEFAULT_POINTER_PREFS, set: 'pixel', size: 48, move: 'pixel', click: 'press', effectsOutsideApp: true })
    const read = parseUiSettingsFile(JSON.stringify(file), { shortcutIds: [] })
    expect(read.ok && read.import.values.some(({ entry }) => entry.key === 'pointerPrefs')).toBe(true)
    const broken = parseUiSettingsFile(JSON.stringify({ ...file, settings: { ...file.settings, pointerPrefs: 'not json', terminalFileZone: 'on' } }), { shortcutIds: [] })
    expect(broken.ok && broken.import.invalid).toBe(1)
  })
})

describe('pointer images', () => {
  it('draws every state of every set as a sized SVG', () => {
    expect(CURSOR_SETS.map(set => set.id)).toEqual(['system', 'big', 'contrast', 'fine', 'paw', 'jelly', 'star', 'heart', 'pixel'])
    for (const set of CURSOR_SETS) {
      for (const state of CURSOR_STATES) {
        const svg = cursorSvg(set, state, 48)
        expect(svg, `${set.id} ${state}`).toMatch(/^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg" width="48" height="48" viewBox="0 0 32 32">/)
        expect(svg).not.toContain('undefined')
        expect(svg).not.toContain('NaN')
      }
    }
  })

  it('scales the hotspot with the image and keeps the OS pointer as the fallback', () => {
    const set = cursorSet('big')
    // The arrow's visible tip, kept inside the image (its outline used to run past the top edge)
    expect(cursorHotspot(set, 'default', 32)).toEqual([2, 2])
    expect(cursorHotspot(set, 'default', 64)).toEqual([3, 3])
    expect(cursorHotspot(set, 'pointer', 48)).toEqual([20, 5])
    expect(cursorValue('blob:x', [6, 6], 'not-allowed')).toBe('url("blob:x") 6 6, not-allowed')
    expect(cursorSet('nope' as never).id).toBe('system')
  })
})

describe('effect color', () => {
  it('darkens a pale accent on a light app and keeps a visible one', () => {
    const yellow = inkFor('#f7d600', '#ffffff')
    expect(yellow.dark).toBe(false)
    const hex = (value: string) => [1, 3, 5].map(i => parseInt(value.slice(i, i + 2), 16)) as [number, number, number]
    expect(contrastRatio(hex(yellow.ink), [255, 255, 255])).toBeGreaterThanOrEqual(3)
    expect(inkFor('#2f6fed', '#1c1d21')).toEqual({ ink: '#2f6fed', dark: true })
    expect(inkFor('rgb(1,2,3)', '#000000').ink).toBe('#4fd1a5')
  })
})
