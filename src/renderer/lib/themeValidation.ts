import type { TerminalColors, ThemeCategory, ThemeColors, ThemeDefinition } from '../types/theme'
import { colorSchemeFor } from './colorScheme'

/**
 * Checks a theme from outside the app (an imported file, or what localStorage kept from an older
 * version) before it is used. A theme missing a field the UI reads (preview.primary) used to blank
 * the whole app, and kept doing so every time settings opened because it stayed stored.
 */

// Records keyed by the interfaces: adding a color to ThemeColors / TerminalColors without listing it here fails to compile
const THEME_COLOR_KEYS = Object.keys({
  bgPrimary: 1, bgSecondary: 1, bgTertiary: 1, bgHover: 1, bgActive: 1, bgModifierHover: 1, bgModifierSelected: 1,
  textPrimary: 1, textSecondary: 1, textMuted: 1, textLink: 1,
  accent: 1, accentHover: 1, accentActive: 1,
  success: 1, warning: 1, error: 1, info: 1,
  border: 1, borderStrong: 1,
  shadowColor: 1, glowColor: 1
} satisfies Record<keyof ThemeColors, 1>) as (keyof ThemeColors)[]

const TERMINAL_COLOR_KEYS = Object.keys({
  background: 1, foreground: 1, cursor: 1, cursorAccent: 1, selectionBackground: 1,
  black: 1, red: 1, green: 1, yellow: 1, blue: 1, magenta: 1, cyan: 1, white: 1,
  brightBlack: 1, brightRed: 1, brightGreen: 1, brightYellow: 1, brightBlue: 1, brightMagenta: 1, brightCyan: 1, brightWhite: 1
} satisfies Record<keyof TerminalColors, 1>) as (keyof TerminalColors)[]

const CATEGORIES: readonly ThemeCategory[] = ['dark', 'light', 'special']
const MAX_NAME_LENGTH = 60
const MAX_ID_LENGTH = 100

// Hex, rgb(a), hsl(a) or transparent: the forms the presets use. Rejects anything that could carry more CSS.
const COLOR_PATTERN = /^(#[0-9a-f]{3,8}|rgba?\([\d.\s,%/]+\)|hsla?\([\d.\s,%/deg]+\)|transparent)$/i

type Json = Record<string, unknown>

const isObject = (value: unknown): value is Json => typeof value === 'object' && value !== null && !Array.isArray(value)
const isColor = (value: unknown): value is string => typeof value === 'string' && COLOR_PATTERN.test(value.trim())

function readColors<K extends string>(raw: unknown, keys: readonly K[]): Record<K, string> | null {
  if (!isObject(raw)) return null
  const entries = keys.map(key => [key, raw[key]] as const)
  if (!entries.every(([, value]) => isColor(value))) return null
  return Object.fromEntries(entries.map(([key, value]) => [key, (value as string).trim()])) as Record<K, string>
}

/** A usable theme built from untrusted data, or null when it cannot be used safely. Unknown fields are dropped. */
export function normalizeTheme(raw: unknown): ThemeDefinition | null {
  if (!isObject(raw)) return null
  const { id, name } = raw
  if (typeof id !== 'string' || id.length === 0 || id.length > MAX_ID_LENGTH) return null
  if (typeof name !== 'string' || name.trim().length === 0) return null

  const colors = readColors(raw.colors, THEME_COLOR_KEYS)
  const terminal = readColors(raw.terminal, TERMINAL_COLOR_KEYS)
  if (!colors || !terminal) return null

  // Older or hand-written files may lack these; both can be derived from the colors
  const preview = readColors(raw.preview, ['primary', 'secondary', 'accent'] as const) ??
    { primary: colors.bgPrimary, secondary: colors.bgSecondary, accent: colors.accent }
  const category = CATEGORIES.includes(raw.category as ThemeCategory)
    ? (raw.category as ThemeCategory)
    : (colorSchemeFor(colors.bgPrimary) ?? 'dark')

  const theme: ThemeDefinition = { id, name: name.trim().slice(0, MAX_NAME_LENGTH), category, colors, terminal, preview }
  if (isObject(raw.effects)) {
    const effects = {
      ...(typeof raw.effects.glow === 'boolean' ? { glow: raw.effects.glow } : {}),
      ...(typeof raw.effects.scanlines === 'boolean' ? { scanlines: raw.effects.scanlines } : {})
    }
    if (Object.keys(effects).length > 0) theme.effects = effects
  }
  return theme
}

/** Custom themes restored from storage: repaired where possible, unusable ones dropped. */
export function sanitizeStoredThemes(raw: unknown): ThemeDefinition[] {
  if (!Array.isArray(raw)) return []
  return raw.map(normalizeTheme).filter((theme): theme is ThemeDefinition => theme !== null)
}
