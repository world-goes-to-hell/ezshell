import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import { PRESET_THEMES } from './presets'
import { CHAT_PRESETS } from './chatThemes'
import { contrastRatio, type Rgb } from '../lib/colorContrast'
import { colorSchemeFor } from '../lib/colorScheme'

// A preset lives twice: the TS definition (terminal colors, previews) and a [data-theme] CSS block (the UI).
const css = ['../styles/variables.css', '../styles/themes-light.css', '../styles/themes-macos.css', '../styles/themes-chat-companion.css']
  .map(file => fs.readFileSync(new URL(file, import.meta.url), 'utf8'))
  .join('\n')

function cssBlock(id: string, attribute = 'data-theme'): Record<string, string> | null {
  const match = new RegExp(`\\[${attribute}="${id}"\\]\\s*\\{([^}]*)\\}`).exec(css)
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
  it('uses the shared macOS radius tokens for the mac window chrome', () => {
    const mac = PRESET_THEMES.filter(t => t.chrome === 'mac')
    expect(mac.map(t => t.id)).toEqual(['macos-light', 'macos-dark'])
    expect(cssBlock('mac', 'data-chrome')?.['--radius-md']).toBe('var(--mac-radius-md)')
    for (const theme of PRESET_THEMES) expect(cssBlock(theme.id)!['--radius-md']).toBeUndefined()
  })

  it('put light-category themes on light backgrounds', () => {
    const light = PRESET_THEMES.filter(t => t.category === 'light')
    expect(light.length).toBeGreaterThanOrEqual(9)
    for (const theme of light) expect(colorSchemeFor(theme.colors.bgPrimary)).toBe('light')
  })
})

const companions = PRESET_THEMES.filter(theme => theme.chatThemeId)

function hexRgb(color: string): Rgb {
  expect(color).toMatch(/^#[\da-f]{6}$/i)
  return [1, 3, 5].map(index => Number.parseInt(color.slice(index, index + 2), 16)) as Rgb
}

function assertContrast(first: string, second: string, minimum: number) {
  expect(contrastRatio(hexRgb(first), hexRgb(second)), `${first} against ${second}`).toBeGreaterThanOrEqual(minimum)
}

describe('app themes paired with chat', () => {
  it('pairs each chat palette with one app theme of the same name', () => {
    expect(companions.map(theme => theme.chatThemeId).sort()).toEqual(CHAT_PRESETS.map(theme => theme.id).sort())
    const special = ['chat-arcade', 'chat-neon', 'chat-amber']
    for (const chat of CHAT_PRESETS) {
      const companion = companions.find(theme => theme.chatThemeId === chat.id)!
      expect(companion.name).toBe(chat.name)
      expect(companion.id).not.toBe(chat.id)
      expect(companion.category).toBe(special.includes(chat.id) ? 'special' : colorSchemeFor(chat.canvas))
      expect(companion.chrome).toBeUndefined()
    }
  })

  it.each(companions)('$name applies the same app colors as its preset', theme => {
    const block = cssBlock(theme.id)!
    for (const [key, color] of Object.entries(theme.colors)) {
      if (key === 'shadowColor' || key === 'glowColor') continue
      const token = `--${key.replace(/[A-Z]/g, letter => `-${letter.toLowerCase()}`)}`
      expect(block[token]).toBe(color)
    }
    expect(block['--shadow-md']).toContain(theme.colors.shadowColor)
    expect(block['--shadow-glow']).toContain(theme.colors.glowColor)
  })

  it.each(companions)('$name keeps app labels, states and focus accents readable', theme => {
    const { colors } = theme
    const block = cssBlock(theme.id)!
    for (const surface of [colors.bgPrimary, colors.bgSecondary, colors.bgTertiary, colors.bgHover]) {
      for (const text of [colors.textPrimary, colors.textSecondary, colors.textMuted, colors.textLink,
        colors.accent, colors.info, colors.success, colors.warning, block['--error-text']]) {
        assertContrast(text, surface, 4.5)
      }
      assertContrast(colors.borderStrong, surface, 3)
    }
    for (const accent of [colors.accent, colors.accentHover, colors.accentActive, colors.bgActive]) {
      assertContrast(block['--on-accent'], accent, 4.5)
    }
  })

  it.each(companions)('$name keeps all terminal inks readable, including in selections', theme => {
    const { foreground, background, selectionBackground, cursor, cursorAccent, ...ansi } = theme.terminal
    const inks = Object.values(ansi)
    expect(inks).toHaveLength(16)
    expect(new Set(inks).size).toBe(16)
    for (const ink of [foreground, ...inks]) {
      assertContrast(ink, background, 4.5)
      assertContrast(ink, selectionBackground, 4.5)
    }
    assertContrast(selectionBackground, background, 1.5)
    assertContrast(cursor, background, 3)
    assertContrast(cursor, cursorAccent, 4.5)
  })
})
