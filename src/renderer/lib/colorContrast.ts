// Text colors used on top of arbitrary (user-chosen) backgrounds such as session colors
const LIGHT_TEXT = '#ffffff'
const DARK_TEXT = '#16181c'

export type Rgb = [number, number, number]

function parseHex(color: string): Rgb | null {
  const hex = color.trim().replace(/^#/, '')
  const full = hex.length === 3 ? hex.split('').map(c => c + c).join('') : hex.slice(0, 6)
  if (!/^[0-9a-fA-F]{6}$/.test(full)) return null
  return [0, 2, 4].map(i => parseInt(full.slice(i, i + 2), 16)) as Rgb
}

function parseOpaqueHex(color: string): Rgb | null {
  const hex = color.trim().replace(/^#/, '')
  if (!/^(?:[0-9a-f]{3}f?|[0-9a-f]{6}(?:ff)?)$/i.test(hex)) return null
  return parseHex(hex.length === 4 ? hex.slice(0, 3) : hex)
}

/** WCAG relative luminance of an sRGB color */
function luminance([r, g, b]: Rgb): number {
  const channel = (value: number) => {
    const c = value / 255
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
  }
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b)
}

export function contrastRatio(first: Rgb, second: Rgb): number {
  const a = luminance(first)
  const b = luminance(second)
  const [lighter, darker] = a > b ? [a, b] : [b, a]
  return (lighter + 0.05) / (darker + 0.05)
}

/** Pick the stronger of black and white for small text or an outline against a solid fill. */
export function contrastingMonochrome(background: string): string {
  const rgb = parseOpaqueHex(background)
  return rgb && contrastRatio([0, 0, 0], rgb) > contrastRatio([255, 255, 255], rgb) ? '#000000' : LIGHT_TEXT
}

/** Keep custom colors when their contrast depends on how the browser paints them. */
export function visibleIndicatorColor(preferred: string, backgrounds: readonly string[], { retainTone = false, minimumRatio = 3 } = {}): string {
  const preferredRgb = parseOpaqueHex(preferred)
  if (!preferredRgb) return preferred
  const surfaces = backgrounds.map(parseOpaqueHex).filter(color => color !== null)
  if (surfaces.length === 0) return preferred
  const minimumContrast = (color: Rgb) => Math.min(...surfaces.map(surface => contrastRatio(color, surface)))
  if (minimumContrast(preferredRgb) >= minimumRatio) return preferred
  const neutral = minimumContrast([0, 0, 0]) > minimumContrast([255, 255, 255]) ? 0 : 255
  if (retainTone) {
    for (let step = 1; step < 20; step++) {
      const color = preferredRgb.map(channel => Math.round(channel + (neutral - channel) * step / 20)) as Rgb
      if (minimumContrast(color) >= minimumRatio) return '#' + color.map(channel => channel.toString(16).padStart(2, '0')).join('')
    }
  }
  return neutral === 0 ? '#000000' : '#ffffff'
}

// White text needs at least this much contrast to be used (WCAG's floor for UI components and bold text)
const MIN_LIGHT_TEXT_CONTRAST = 3

/**
 * Text color for the given background: white wherever it is legible, near-black on backgrounds too
 * light for it (yellow, green, pastel). White is preferred over "whichever contrasts more" because a
 * filled blue or red tab with black text reads as unstyled, although black measures higher there.
 * Non-hex colors fall back to white.
 */
export function readableTextColor(background: string): string {
  const rgb = parseHex(background)
  if (!rgb) return LIGHT_TEXT
  const onLight = contrastRatio(rgb, [255, 255, 255])
  return onLight >= MIN_LIGHT_TEXT_CONTRAST ? LIGHT_TEXT : DARK_TEXT
}
