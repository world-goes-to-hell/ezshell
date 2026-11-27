import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  assignProjectHues, DEFAULT_PROJECT_COLORS, HARMONY_PALETTE, hueDistance, PROJECT_COLORS_EVENT, PROJECT_COLORS_KEY,
  readProjectColors, writeProjectColors, type ProjectColorSettings
} from './localProjectColors'

const keys = (count: number) => Array.from({ length: count }, (_, index) => `c:\\work\\p${index}`)
const settings = (patch: Partial<ProjectColorSettings> = {}): ProjectColorSettings => ({ ...DEFAULT_PROJECT_COLORS, ...patch })
const huesOf = (assigned: Record<string, number>, order: string[]) => order.map(key => assigned[key])

describe('harmony scheme', () => {
  it.each([1, 2, 3, 10, 13])('uses only palette hues, in the palette order, for %i projects', count => {
    const order = keys(count)
    const hues = huesOf(assignProjectHues(order, settings()), order)
    expect(hues).toEqual(order.map((_, index) => HARMONY_PALETTE[index % HARMONY_PALETTE.length].hue))
  })

  it('keeps neighbours apart and fills a few projects across the wheel', () => {
    const palette = HARMONY_PALETTE.map(entry => entry.hue)
    for (let index = 0; index < palette.length; index++) {
      expect(hueDistance(palette[index], palette[(index + 1) % palette.length])).toBeGreaterThanOrEqual(60)
    }
    // Any first three cover the wheel: none closer than 80°
    const [a, b, c] = palette
    expect(Math.min(hueDistance(a, b), hueDistance(b, c), hueDistance(a, c))).toBeGreaterThanOrEqual(80)
  })

  it('leaves out muddy olive and yellow-green hues', () => {
    for (const { hue } of HARMONY_PALETTE) expect(hue >= 95 && hue <= 125).toBe(false)
  })

  it('gives a chosen colour first and skips palette hues close to it', () => {
    const order = keys(3)
    const assigned = assignProjectHues(order, settings({ manual: { [order[1]]: 255 } }))
    expect(assigned[order[1]]).toBe(255)
    // Blue (250) is within 25° of the chosen 255: the others take the next palette hues
    expect([assigned[order[0]], assigned[order[2]]]).toEqual([HARMONY_PALETTE[1].hue, HARMONY_PALETTE[2].hue])
  })

  it('does not skip when the palette would run short', () => {
    const order = keys(11)
    const manual = Object.fromEntries(HARMONY_PALETTE.map((entry, index) => [`m${index}`, entry.hue]))
    const assigned = assignProjectHues(order, settings({ manual }))
    expect(huesOf(assigned, order).every(hue => HARMONY_PALETTE.some(entry => entry.hue === hue))).toBe(true)
  })
})

describe('analogous and uniform schemes', () => {
  it('stays within 45° of the base hue and alternates the ends so neighbours differ', () => {
    const order = keys(5)
    const hues = huesOf(assignProjectHues(order, settings({ scheme: 'analogous', baseHue: 200 })), order)
    expect(hues).toEqual([155, 245, 177.5, 222.5, 200].map(Math.round))
    for (const hue of hues) expect(hueDistance(hue, 200)).toBeLessThanOrEqual(45)
    expect(assignProjectHues(['one'], settings({ scheme: 'analogous', baseHue: 10 }))).toEqual({ one: 10 })
  })

  it('wraps around 0°', () => {
    const hues = Object.values(assignProjectHues(keys(2), settings({ scheme: 'analogous', baseHue: 20 })))
    expect(hues).toEqual([335, 65])
  })

  it('gives every project the base hue, except a chosen colour', () => {
    const order = keys(3)
    const assigned = assignProjectHues(order, settings({ scheme: 'uniform', baseHue: 140, manual: { [order[2]]: 30 } }))
    expect(huesOf(assigned, order)).toEqual([140, 140, 30])
  })
})

describe('stored colours', () => {
  beforeEach(() => {
    const stored = new Map<string, string>()
    vi.stubGlobal('localStorage', { getItem: (key: string) => stored.get(key) ?? null, setItem: (key: string, value: string) => { stored.set(key, value) } })
    vi.stubGlobal('window', new EventTarget())
  })
  afterEach(() => vi.unstubAllGlobals())

  it('reads the defaults when nothing or something broken is stored', () => {
    expect(readProjectColors()).toEqual(DEFAULT_PROJECT_COLORS)
    localStorage.setItem(PROJECT_COLORS_KEY, '{broken')
    expect(readProjectColors()).toEqual(DEFAULT_PROJECT_COLORS)
  })

  it('keeps only whole hues from 0 to 359 and known schemes', () => {
    localStorage.setItem(PROJECT_COLORS_KEY, JSON.stringify({
      scheme: 'neon', baseHue: 400, manual: { a: 30, b: -1, c: 12.5, d: 'red', e: 359 }
    }))
    expect(readProjectColors()).toEqual({ ...DEFAULT_PROJECT_COLORS, manual: { a: 30, e: 359 } })
  })

  it('saves, tells other readers, and reads back', () => {
    let told = 0
    const listener = () => { told++ }
    window.addEventListener(PROJECT_COLORS_EVENT, listener)
    const next = settings({ scheme: 'uniform', baseHue: 75, manual: { a: 300 } })
    expect(writeProjectColors(next)).toBe(true)
    window.removeEventListener(PROJECT_COLORS_EVENT, listener)
    expect(told).toBe(1)
    expect(readProjectColors()).toEqual(next)
  })
})
