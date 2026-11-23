// The effects' color: the theme accent, darkened (light themes) or lightened (dark themes) until it
// stands out from the app background. A yellow accent on a white app would otherwise vanish.
import { contrastRatio, type Rgb } from './colorContrast'

const MIN_CONTRAST = 3
const FALLBACK = '#4fd1a5'

function hex(value: string): Rgb | null {
  const match = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(value.trim())
  if (!match) return null
  const digits = match[1].length === 3 ? [...match[1]].map(c => c + c).join('') : match[1]
  const n = parseInt(digits, 16)
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255]
}

const toHex = (rgb: Rgb) => '#' + rgb.map(c => Math.round(c).toString(16).padStart(2, '0')).join('')
const luminance = ([r, g, b]: Rgb) => (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255

export function inkFor(accent: string, background: string): { ink: string; dark: boolean } {
  const bg = hex(background)
  const dark = bg ? luminance(bg) < 0.5 : true
  const color = hex(accent)
  if (!color || !bg) return { ink: color ? toHex(color) : FALLBACK, dark }
  const toward: Rgb = dark ? [255, 255, 255] : [0, 0, 0]
  for (let step = 0; step <= 10; step++) {
    const t = step / 10
    const mixed: Rgb = [0, 1, 2].map(i => color[i] + (toward[i] - color[i]) * t) as Rgb
    if (contrastRatio(mixed, bg) >= MIN_CONTRAST) return { ink: toHex(mixed), dark }
  }
  return { ink: toHex(toward), dark }
}

/** From the window's computed style: the theme's motion accent (themeStore), else its accent */
export function effectInk(style: { getPropertyValue(name: string): string }): { ink: string; dark: boolean } {
  const accent = style.getPropertyValue('--motion-accent').trim() || style.getPropertyValue('--accent')
  return inkFor(accent, style.getPropertyValue('--bg-primary'))
}
