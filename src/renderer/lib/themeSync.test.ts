import { describe, it, expect } from 'vitest'
import { themeIdFromStorageValue, THEME_STORAGE_KEY } from './themeSync'

describe('themeIdFromStorageValue', () => {
  it('reads the theme id from the persisted theme store', () => {
    const value = JSON.stringify({ state: { currentThemeId: 'ayu-mirage', customThemes: [] }, version: 0 })
    expect(themeIdFromStorageValue(value)).toBe('ayu-mirage')
  })

  it('returns null for a cleared key', () => {
    expect(themeIdFromStorageValue(null)).toBeNull()
  })

  it('returns null for malformed data instead of throwing', () => {
    expect(themeIdFromStorageValue('{not json')).toBeNull()
    expect(themeIdFromStorageValue(JSON.stringify({ state: {} }))).toBeNull()
    expect(themeIdFromStorageValue(JSON.stringify({ state: { currentThemeId: 42 } }))).toBeNull()
  })

  it('uses the same storage key as the theme store', () => {
    expect(THEME_STORAGE_KEY).toBe('theme-store')
  })
})
