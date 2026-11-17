/**
 * Appearance options that sit beside the color theme:
 * - surface style: flat (solid panels) or glass (translucent panels that blur what is behind them)
 * - window opacity: the whole window made see-through, so the desktop shows behind it
 */

export type SurfaceStyle = 'flat' | 'glass'

/** Below this the window is too faint to read or to find again */
export const MIN_WINDOW_OPACITY = 0.5
export const MAX_WINDOW_OPACITY = 1

// Glass lowers contrast on purpose; a theme chosen for contrast keeps solid surfaces
const SOLID_ONLY_THEMES = new Set(['high-contrast'])

export function parseSurface(value: unknown): SurfaceStyle {
  return value === 'glass' ? 'glass' : 'flat'
}

/** The surface actually drawn for a theme: the user's choice, except on themes that stay solid */
export function effectiveSurface(themeId: string, surface: SurfaceStyle): SurfaceStyle {
  return SOLID_ONLY_THEMES.has(themeId) ? 'flat' : surface
}

/** An opacity the window can take: anything unreadable becomes fully opaque */
export function clampWindowOpacity(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return MAX_WINDOW_OPACITY
  return Math.round(Math.min(MAX_WINDOW_OPACITY, Math.max(MIN_WINDOW_OPACITY, value)) * 100) / 100
}
