import { describe, it, expect } from 'vitest'
import { normalizeTheme, sanitizeStoredThemes } from './themeValidation'
import { PRESET_THEMES } from '../themes/presets'

const base = PRESET_THEMES[0]
const clone = <T,>(value: T): T => JSON.parse(JSON.stringify(value))

describe('normalizeTheme', () => {
  it('accepts every preset as is', () => {
    for (const preset of PRESET_THEMES) {
      expect(normalizeTheme(clone(preset))).toEqual(preset)
    }
  })

  it('fills a missing preview from the theme colors (the file that blanked the app)', () => {
    const { preview: _preview, ...withoutPreview } = clone(base)

    const theme = normalizeTheme(withoutPreview)

    expect(theme?.preview).toEqual({ primary: base.colors.bgPrimary, secondary: base.colors.bgSecondary, accent: base.colors.accent })
  })

  it('derives a missing or unknown category from the background', () => {
    const light = clone(PRESET_THEMES.find(t => t.id === 'minimal-light')!)

    expect(normalizeTheme({ ...light, category: undefined })?.category).toBe('light')
    expect(normalizeTheme({ ...clone(base), category: 'neon' })?.category).toBe('dark')
  })

  it('rejects themes missing a color, or with a value that is not a color', () => {
    const missing = clone(base) as unknown as { colors: Record<string, unknown> }
    delete missing.colors.accent
    expect(normalizeTheme(missing)).toBeNull()

    const terminalMissing = clone(base) as unknown as { terminal: Record<string, unknown> }
    delete terminalMissing.terminal.brightWhite
    expect(normalizeTheme(terminalMissing)).toBeNull()

    expect(normalizeTheme({ ...clone(base), colors: { ...base.colors, accent: 'red; background: url(x)' } })).toBeNull()
    expect(normalizeTheme({ ...clone(base), colors: { ...base.colors, accent: 42 } })).toBeNull()
  })

  it('rejects anything that is not a named theme object', () => {
    expect(normalizeTheme(null)).toBeNull()
    expect(normalizeTheme('theme')).toBeNull()
    expect(normalizeTheme([])).toBeNull()
    expect(normalizeTheme({ ...clone(base), name: '   ' })).toBeNull()
    expect(normalizeTheme({ ...clone(base), id: 3 })).toBeNull()
  })

  it('keeps only known fields and trims the name', () => {
    const theme = normalizeTheme({ ...clone(base), name: '  내 테마  ', extra: '<script>', effects: { glow: true, other: 1 } })

    expect(theme?.name).toBe('내 테마')
    expect(theme).not.toHaveProperty('extra')
    expect(theme?.effects).toEqual({ glow: true })
  })
})

describe('sanitizeStoredThemes', () => {
  it('repairs what it can and drops the rest, so a bad stored theme cannot take the app down', () => {
    const { preview: _preview, ...noPreview } = clone(base)
    const broken = { id: 'custom-2', name: 'x' }

    const result = sanitizeStoredThemes([{ ...noPreview, id: 'custom-1' }, broken, 'junk'])

    expect(result.map(t => t.id)).toEqual(['custom-1'])
    expect(result[0].preview.primary).toBe(base.colors.bgPrimary)
  })

  it('treats a non-array as no themes', () => {
    expect(sanitizeStoredThemes(undefined)).toEqual([])
    expect(sanitizeStoredThemes({})).toEqual([])
  })
})
