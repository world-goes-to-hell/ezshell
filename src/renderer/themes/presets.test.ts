import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import { PRESET_THEMES } from './presets'
import { colorSchemeFor } from '../lib/colorScheme'

// A preset lives twice: the TS definition (terminal colors, previews) and a [data-theme] CSS block (the UI).
const css = ['../styles/variables.css', '../styles/themes-light.css', '../styles/themes-macos.css']
  .map(file => fs.readFileSync(new URL(file, import.meta.url), 'utf8'))
  .join('\n')

function cssBlock(id: string): Record<string, string> | null {
  const match = new RegExp(`\\[data-theme="${id}"\\]\\s*\\{([^}]*)\\}`).exec(css)
  if (!match) return null
  return Object.fromEntries(
    [...match[1].matchAll(/(--[\w-]+):\s*([^;]+);/g)].map(([, name, value]) => [name, value.trim().toLowerCase()])
  )
}

describe('preset themes', () => {
  it('have unique ids', () => {
    const ids = PRESET_THEMES.map(t => t.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it.each(PRESET_THEMES.map(t => [t.id, t] as const))('%s has a CSS block with the same core colors', (id, theme) => {
    const block = cssBlock(id)
    expect(block).not.toBeNull()
    expect(block!['--bg-primary']).toBe(theme.colors.bgPrimary.toLowerCase())
    expect(block!['--text-primary']).toBe(theme.colors.textPrimary.toLowerCase())
    expect(block!['--accent']).toBe(theme.colors.accent.toLowerCase())
    expect(block!['--on-accent']).toBeDefined()
    expect(block!['--error-text']).toBeDefined()
  })

  // The shape rules ([data-chrome="mac"]) assume curves: a mac-chrome theme left square would show round
  // traffic lights on a square UI
  it('give mac-chrome themes rounded corners, and only those', () => {
    const mac = PRESET_THEMES.filter(t => t.chrome === 'mac')
    expect(mac.map(t => t.id)).toEqual(['macos-light', 'macos-dark'])
    for (const theme of mac) expect(cssBlock(theme.id)!['--radius-md']).toMatch(/^[1-9]\d*px$/)
    for (const theme of PRESET_THEMES.filter(t => t.chrome !== 'mac')) {
      expect(cssBlock(theme.id)!['--radius-md']).toBeUndefined()
    }
  })

  it('put light-category themes on light backgrounds', () => {
    const light = PRESET_THEMES.filter(t => t.category === 'light')
    expect(light.length).toBeGreaterThanOrEqual(9)
    for (const theme of light) expect(colorSchemeFor(theme.colors.bgPrimary)).toBe('light')
  })
})
