// Text colors used on top of arbitrary (user-chosen) backgrounds such as session colors
const LIGHT_TEXT = '#ffffff'
const DARK_TEXT = '#16181c'

function parseHex(color: string): [number, number, number] | null {
  const hex = color.trim().replace(/^#/, '')
  const full = hex.length === 3 ? hex.split('').map(c => c + c).join('') : hex.slice(0, 6)
  if (!/^[0-9a-fA-F]{6}$/.test(full)) return null
  return [0, 2, 4].map(i => parseInt(full.slice(i, i + 2), 16)) as [number, number, number]
}

/** WCAG relative luminance of an sRGB color */
function luminance([r, g, b]: [number, number, number]): number {
  const channel = (value: number) => {
    const c = value / 255
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
  }
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b)
}

function contrastRatio(a: number, b: number): number {
  const [lighter, darker] = a > b ? [a, b] : [b, a]
  return (lighter + 0.05) / (darker + 0.05)
}

/**
 * Pick white or near-black text for the given background, whichever contrasts more.
 * Non-hex colors fall back to white.
 */
export function readableTextColor(background: string): string {
  const rgb = parseHex(background)
  if (!rgb) return LIGHT_TEXT
  const bg = luminance(rgb)
  const onLight = contrastRatio(bg, luminance([255, 255, 255]))
  const onDark = contrastRatio(bg, luminance(parseHex(DARK_TEXT)!))
  return onLight >= onDark ? LIGHT_TEXT : DARK_TEXT
}
