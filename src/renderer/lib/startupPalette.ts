import type { ThemeDefinition } from '../types/theme'
import { contrastRatio, type Rgb } from './colorContrast'

const dark: Rgb = [23, 24, 27]
const light: Rgb = [255, 255, 255]
const defaultBackground: Rgb = [28, 29, 33]
const defaultAccent: Rgb = [47, 111, 237]

export function mixRgb(from: Rgb, to: Rgb, fraction: number): Rgb {
  return [
    Math.round(from[0] + (to[0] - from[0]) * fraction),
    Math.round(from[1] + (to[1] - from[1]) * fraction),
    Math.round(from[2] + (to[2] - from[2]) * fraction),
  ]
}

export function createStartupPalette(theme: ThemeDefinition) {
  const canvas = document.createElement('canvas')
  canvas.width = canvas.height = 1
  const context = canvas.getContext('2d', { willReadFrequently: true })
  if (!context) throw new Error('Startup colors cannot be resolved')

  // Canvas resolves hex, RGB and HSL from the theme the same way it draws them.
  const readColor = (value: string, fallback: Rgb): Rgb => {
    context.clearRect(0, 0, 1, 1)
    context.fillStyle = 'transparent'
    context.fillStyle = value
    context.fillRect(0, 0, 1, 1)
    const [r, g, b, alpha] = context.getImageData(0, 0, 1, 1).data
    return alpha ? [r, g, b] : fallback
  }

  const background = readColor(theme.colors.bgPrimary, defaultBackground)
  const lightInk = contrastRatio(light, background) >= contrastRatio(dark, background)
  const neutral = lightInk ? light : dark
  const accent = readColor(theme.colors.accent, defaultAccent)
  const tune = (color: Rgb) => {
    // Most logo dots are drawn at roughly 80% opacity.
    for (let step = 0; step < 12; step++) {
      const candidate = mixRgb(color, neutral, step / 12)
      if (contrastRatio(mixRgb(background, candidate, .8), background) >= 3) return candidate
    }
    return neutral
  }
  return {
    prompt: tune(accent),
    lettering: tune(readColor(theme.terminal.cyan, accent)),
    secondary: tune(readColor(theme.terminal.magenta, accent)),
    cursor: tune(readColor(theme.terminal.cursor, accent)),
    highlight: tune(readColor(theme.terminal.foreground, neutral)),
    outline: lightInk ? 'rgb(12 15 21 / 65%)' : 'rgb(247 248 251 / 70%)',
  }
}
