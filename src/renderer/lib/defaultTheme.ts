/**
 * The theme a first run starts with (nothing saved yet). On macOS the app follows the system look with the
 * macOS-style pair; elsewhere it stays on Minimal Dark. A saved choice always wins (themeStore's merge).
 */

export const FALLBACK_THEME_ID = 'minimal-dark'

export function isMacPlatform(platform: string | undefined | null): boolean {
  return typeof platform === 'string' && /^mac/i.test(platform.trim())
}

export function defaultThemeId(platform: string | undefined | null, prefersDark: boolean): string {
  if (!isMacPlatform(platform)) return FALLBACK_THEME_ID
  return prefersDark ? 'macos-dark' : 'macos-light'
}

/** Reads the platform and system appearance from the renderer; anything unreadable falls back. */
export function detectDefaultThemeId(): string {
  try {
    const nav = navigator as Navigator & { userAgentData?: { platform?: string } }
    const platform = nav.userAgentData?.platform || nav.platform
    const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches
    return defaultThemeId(platform, prefersDark)
  } catch {
    return FALLBACK_THEME_ID
  }
}
