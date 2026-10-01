/**
 * Whether a theme is dark or light, from its main background. Set as the document's color-scheme so the
 * parts Chromium draws itself (open select lists, color picker, scrollbars, form controls) follow the theme.
 */

// Relative luminance below this reads as a dark surface (mid-gray #777 is about 0.18)
const DARK_LUMINANCE = 0.18

function relativeLuminance(hex: string): number | null {
  const match = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(hex.trim())
  if (!match) return null
  const digits = match[1].length === 3 ? [...match[1]].map(d => d + d).join('') : match[1]
  const [r, g, b] = [0, 2, 4]
    .map(i => parseInt(digits.slice(i, i + 2), 16) / 255)
    .map(c => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4))
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

export function colorSchemeFor(background: string): 'dark' | 'light' | null {
  const luminance = relativeLuminance(background)
  if (luminance === null) return null
  return luminance < DARK_LUMINANCE ? 'dark' : 'light'
}
