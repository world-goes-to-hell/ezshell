// Colours of the sidebar's local work cards (docs/plan/2026-11-27-local-project-colors.md). Only the hue is
// chosen: the card draws it as oklch(66% 0.14 <hue>), so every colour reads the same in light and dark themes.
//
// Automatic colours come from a chosen palette, not from slicing the colour wheel: a wheel cut into N parts
// mixes in muddy olive and yellow-green and looks like a rainbow (user, 2026-11-27: neighbours must differ,
// and the set must not look odd). A colour the user picked for a project always wins.

export type ProjectColorScheme = 'harmony' | 'analogous' | 'uniform'

export interface ProjectColorSettings {
  scheme: ProjectColorScheme
  /** The centre of `analogous` and the one colour of `uniform` */
  baseHue: number
  /** Hues picked per project, by the project's key (projectKeyOf) */
  manual: Record<string, number>
}

export const PROJECT_COLORS_KEY = 'ezshell.localProjectColors'
export const PROJECT_COLORS_EVENT = 'ezshell:local-project-colors-changed'
export const DEFAULT_PROJECT_COLORS: ProjectColorSettings = { scheme: 'harmony', baseHue: 250, manual: {} }

/**
 * In this order any first few spread over the wheel (the first three are at least 80° apart) and each
 * next one is at least 60° from the one before, so neighbouring cards differ. No hue in 95–125°.
 */
export const HARMONY_PALETTE: ReadonlyArray<{ hue: number; name: string }> = [
  { hue: 250, name: '파랑' }, { hue: 165, name: '청록' }, { hue: 35, name: '산호' }, { hue: 300, name: '보라' },
  { hue: 215, name: '하늘' }, { hue: 75, name: '호박' }, { hue: 350, name: '장미' }, { hue: 140, name: '초록' },
  { hue: 275, name: '남색' }, { hue: 185, name: '옥색' }
]

const SCHEMES: readonly ProjectColorScheme[] = ['harmony', 'analogous', 'uniform']
const ANALOGOUS_SPREAD = 45
// A palette hue this close to a picked one is left to the picked project
const NEAR_PICKED = 25
const MAX_MANUAL = 200

export const projectColor = (hue: number) => `oklch(66% 0.14 ${hue})`
const wrap = (hue: number) => Math.round(((hue % 360) + 360) % 360) % 360
export const hueDistance = (a: number, b: number) => { const gap = Math.abs(wrap(a) - wrap(b)); return Math.min(gap, 360 - gap) }
const validHue = (value: unknown): value is number => Number.isInteger(value) && (value as number) >= 0 && (value as number) <= 359

function harmonyHues(count: number, picked: number[]): number[] {
  const free = HARMONY_PALETTE.map(entry => entry.hue).filter(hue => picked.every(other => hueDistance(hue, other) >= NEAR_PICKED))
  const palette = free.length >= count ? free : HARMONY_PALETTE.map(entry => entry.hue)
  return Array.from({ length: count }, (_, index) => palette[index % palette.length])
}

// Evenly within ±45° of the base, handed out from both ends inwards so neighbours are as far apart as the band allows
function analogousHues(count: number, base: number): number[] {
  if (count <= 1) return count ? [wrap(base)] : []
  const step = (ANALOGOUS_SPREAD * 2) / (count - 1)
  const positions = Array.from({ length: count }, (_, index) => base - ANALOGOUS_SPREAD + index * step)
  const order: number[] = []
  for (let low = 0, high = count - 1; low <= high; low++, high--) {
    order.push(low)
    if (high !== low) order.push(high)
  }
  return order.map(index => wrap(positions[index]))
}

/** The hue of each project, in the order the sidebar shows them */
export function assignProjectHues(keys: readonly string[], settings: ProjectColorSettings): Record<string, number> {
  const automatic = keys.filter(key => !validHue(settings.manual[key]))
  const picked = keys.filter(key => validHue(settings.manual[key])).map(key => settings.manual[key])
  const hues = settings.scheme === 'uniform' ? automatic.map(() => wrap(settings.baseHue))
    : settings.scheme === 'analogous' ? analogousHues(automatic.length, settings.baseHue)
      : harmonyHues(automatic.length, picked)
  const assigned: Record<string, number> = {}
  automatic.forEach((key, index) => { assigned[key] = hues[index] })
  for (const key of keys) if (validHue(settings.manual[key])) assigned[key] = settings.manual[key]
  return assigned
}

export function readProjectColors(): ProjectColorSettings {
  try {
    const data: unknown = JSON.parse(localStorage.getItem(PROJECT_COLORS_KEY) ?? 'null')
    if (!data || typeof data !== 'object') return DEFAULT_PROJECT_COLORS
    const { scheme, baseHue, manual } = data as Partial<ProjectColorSettings>
    const entries = manual && typeof manual === 'object' ? Object.entries(manual) : []
    return {
      scheme: SCHEMES.includes(scheme as ProjectColorScheme) ? scheme as ProjectColorScheme : DEFAULT_PROJECT_COLORS.scheme,
      baseHue: validHue(baseHue) ? baseHue : DEFAULT_PROJECT_COLORS.baseHue,
      manual: Object.fromEntries(entries.filter(([key, hue]) => key.length > 0 && key.length <= 4096 && validHue(hue)).slice(0, MAX_MANUAL))
    }
  } catch {
    return DEFAULT_PROJECT_COLORS
  }
}

/** Saves and tells the other readers; false when it could not be stored */
export function writeProjectColors(settings: ProjectColorSettings): boolean {
  try {
    localStorage.setItem(PROJECT_COLORS_KEY, JSON.stringify(settings))
  } catch {
    return false
  }
  window.dispatchEvent(new Event(PROJECT_COLORS_EVENT))
  return true
}
