/** localStorage key the theme store persists under (zustand persist `name`) */
export const THEME_STORAGE_KEY = 'theme-store'

/**
 * Theme id from a persisted theme-store value, as seen in another window's `storage` event.
 * Returns null for a cleared key or data that does not look like the theme store.
 */
export function themeIdFromStorageValue(value: string | null): string | null {
  if (!value) return null
  try {
    const parsed: unknown = JSON.parse(value)
    const id = (parsed as { state?: { currentThemeId?: unknown } })?.state?.currentThemeId
    return typeof id === 'string' && id ? id : null
  } catch {
    return null
  }
}
