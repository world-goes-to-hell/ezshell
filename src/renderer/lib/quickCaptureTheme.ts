import { contrastRatio, type Rgb } from './colorContrast'
import type { QuickCaptureTheme, ThemeColors } from '../types/theme'

const black: Rgb = [0, 0, 0]
const white: Rgb = [255, 255, 255]
const hex = (color: Rgb) => '#' + color.map(channel => channel.toString(16).padStart(2, '0')).join('')

function contrasting(color: Rgb, surfaces: Rgb[], minimum: number): Rgb {
  const ratio = (ink: Rgb) => Math.min(...surfaces.map(surface => contrastRatio(ink, surface)))
  if (ratio(color) >= minimum) return color
  const end = ratio(black) >= ratio(white) ? black : white
  for (let step = 1; step < 16; step++) {
    const mixed = color.map((channel, index) => Math.round(channel + (end[index] - channel) * step / 16)) as Rgb
    if (ratio(mixed) >= minimum) return mixed
  }
  return end
}

export function quickCaptureTheme(colors: ThemeColors, tokens: CSSStyleDeclaration, scheme: 'light' | 'dark'): QuickCaptureTheme | undefined {
  const canvas = document.createElement('canvas')
  canvas.width = canvas.height = 1
  const context = canvas.getContext('2d', { willReadFrequently: true })
  if (!context) return
  // Resolve custom CSS colors to sRGB and flatten alpha over a theme surface. The captured desktop
  // can be any color, so it cannot be part of the controls' contrast calculation.
  const pixel = (value: string, behind: Rgb): Rgb => {
    context.fillStyle = hex(behind)
    context.fillRect(0, 0, 1, 1)
    context.fillStyle = value
    context.fillRect(0, 0, 1, 1)
    const [r, g, b] = context.getImageData(0, 0, 1, 1).data
    return [r, g, b]
  }
  const token = (name: string) => tokens.getPropertyValue(name).trim()
  const background = pixel(colors.bgPrimary, scheme === 'light' ? white : [19, 24, 32])
  const surface = pixel(colors.bgSecondary, background)
  const surfaces = [surface, background]
  const accent = contrasting(pixel(colors.accent, surface), [surface], 3)
  return {
    background: hex(background),
    surface: hex(surface),
    border: hex(contrasting(pixel(colors.borderStrong, surface), surfaces, 3)),
    text: hex(contrasting(pixel(colors.textPrimary, surface), surfaces, 4.5)),
    muted: hex(contrasting(pixel(colors.textSecondary, surface), surfaces, 4.5)),
    accent: hex(accent),
    onAccent: hex(contrasting(pixel(token('--on-accent') || '#ffffff', accent), [accent], 4.5)),
    focus: hex(contrasting(pixel(colors.textLink, surface), surfaces, 3)),
    danger: hex(contrasting(pixel(colors.error, surface), [surface], 4.5)),
    radius: token('--radius-md'),
    panelRadius: token('--radius-lg'),
    font: token('--font-sans'),
    scheme
  }
}
