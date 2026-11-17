import { describe, it, expect } from 'vitest'
import { defaultThemeId, isMacPlatform, FALLBACK_THEME_ID } from './defaultTheme'
import { PRESET_THEMES } from '../themes/presets'

describe('defaultThemeId', () => {
  it('follows the system look on macOS', () => {
    expect(defaultThemeId('macOS', true)).toBe('macos-dark')
    expect(defaultThemeId('macOS', false)).toBe('macos-light')
    expect(defaultThemeId('MacIntel', false)).toBe('macos-light')
  })

  it('stays on the usual default elsewhere, whatever the system look', () => {
    for (const platform of ['Windows', 'Win32', 'Linux', 'Linux x86_64', '', undefined, null]) {
      expect(defaultThemeId(platform, true)).toBe(FALLBACK_THEME_ID)
      expect(defaultThemeId(platform, false)).toBe(FALLBACK_THEME_ID)
    }
  })

  it('does not take a platform that merely contains "mac"', () => {
    expect(isMacPlatform('Tarmac OS')).toBe(false)
  })

  it('only returns ids that exist as presets', () => {
    const ids = PRESET_THEMES.map(theme => theme.id)
    for (const id of [defaultThemeId('macOS', true), defaultThemeId('macOS', false), defaultThemeId('Win32', true)]) {
      expect(ids).toContain(id)
    }
  })
})
