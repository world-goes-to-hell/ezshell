import { describe, expect, it } from 'vitest'
import { contrastRatio, type Rgb } from '../lib/colorContrast'
import { CHAT_PRESETS, FOLLOW_APP_CHAT_THEME, chatAppearance } from './chatThemes'
import { PRESET_THEMES } from './presets'

function rgb(hex: string): Rgb {
  return [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16)) as Rgb
}

function ratio(a: string, b: string) {
  return contrastRatio(rgb(a), rgb(b))
}

function vars(id: string) {
  const look = chatAppearance(id, [])
  if (!look) throw new Error(`no appearance for ${id}`)
  return look.style as Record<string, string>
}

describe('chat preset motion colors', () => {
  it.each(CHAT_PRESETS.map(preset => [preset.name, preset] as const))('%s: focus and trace stand out from the canvas', (_name, preset) => {
    // WCAG 1.4.11: borders that carry state need 3:1 against what they sit on
    expect(ratio(preset.motion.focus, preset.canvas)).toBeGreaterThanOrEqual(3)
    expect(ratio(preset.motion.trace, preset.canvas)).toBeGreaterThanOrEqual(3)
  })

  it.each(CHAT_PRESETS.map(preset => [preset.name, preset] as const))('%s: working color is readable as text', (_name, preset) => {
    expect(ratio(preset.motion.working, preset.colors.bgPrimary)).toBeGreaterThanOrEqual(4.5)
    expect(ratio(preset.motion.working, preset.canvas)).toBeGreaterThanOrEqual(4.5)
  })

  it.each(CHAT_PRESETS.map(preset => [preset.name, preset] as const))('%s: the trace differs from the focus border it runs beside', (_name, preset) => {
    expect(preset.motion.trace.toLowerCase()).not.toBe(preset.motion.focus.toLowerCase())
  })

  it.each(CHAT_PRESETS.map(preset => [preset.name, preset] as const))('%s: text on the accent is legible', (_name, preset) => {
    expect(ratio(vars(preset.id)['--on-accent'], preset.colors.accent)).toBeGreaterThanOrEqual(3)
  })

  it.each(CHAT_PRESETS.map(preset => [preset.name, preset] as const))('%s: messages and answer links are readable', (_name, preset) => {
    const { textPrimary, textLink, bgSecondary } = preset.colors
    expect(ratio(textPrimary, bgSecondary)).toBeGreaterThanOrEqual(4.5)
    expect(ratio(textPrimary, preset.outgoing)).toBeGreaterThanOrEqual(4.5)
    expect(ratio(textLink, bgSecondary)).toBeGreaterThanOrEqual(4.5)
  })

  it('exposes the motion colors as variables for the pane effects', () => {
    const preset = CHAT_PRESETS[0]
    const style = vars(preset.id)
    expect(style['--chat-focus']).toBe(preset.motion.focus)
    expect(style['--chat-working']).toBe(preset.motion.working)
    expect(style['--motion-accent']).toBe(preset.motion.trace)
    expect(style['--chat-trace']).toBe(preset.motion.trace)
    expect(style['--terminal-foreground']).toBe(preset.colors.textPrimary)
  })
})

describe('app theme used as the chat theme', () => {
  it.each(['macos-light', 'macos-dark'])('%s uses the window theme’s rounded corners in the chat', id => {
    const style = vars(id)
    expect(style['--radius-sm']).toBe('var(--mac-radius-sm)')
    expect(style['--radius-md']).toBe('var(--mac-radius-md)')
    expect(style['--radius-lg']).toBe('var(--mac-radius-lg)')
  })

  it('keeps the old trace formula with that theme, not the window theme', () => {
    const theme = PRESET_THEMES.find(item => item.id === 'minimal-light') ?? PRESET_THEMES[0]
    const style = vars(theme.id)
    expect(style['--motion-accent']).toBe(theme.colors.accent)
    expect(style['--chat-focus']).toBe(theme.colors.accent)
    expect(style['--terminal-foreground']).toBe(theme.terminal.foreground)
    expect(style['--chat-trace']).toBeUndefined()
    expect(style['--radius-md']).toBeUndefined()
  })

  it('following the app theme sets nothing', () => {
    expect(chatAppearance(FOLLOW_APP_CHAT_THEME, [])).toBeUndefined()
  })
})
