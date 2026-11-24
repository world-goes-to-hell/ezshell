import { describe, expect, it } from 'vitest'
import { contrastRatio, type Rgb } from '../lib/colorContrast'
import { CHAT_PRESETS, FOLLOW_APP_CHAT_THEME, appPaneIndicatorColors, chatAppearance, chatPickerAppThemes, chatThemeChoice } from './chatThemes'
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
  it.each(CHAT_PRESETS.map(preset => [preset.name, preset] as const))('%s: inner focus and trace contrast with the chat and its chrome', (_name, preset) => {
    const style = vars(preset.id)
    for (const backdrop of [preset.canvas, preset.colors.bgSecondary]) {
      expect(ratio(style['--pane-focus-color'], backdrop)).toBeGreaterThanOrEqual(3)
      // The trace is inset into the pane, so its two edges run over these same surfaces.
      expect(ratio(style['--pane-trace-color'], backdrop)).toBeGreaterThanOrEqual(3)
    }
    expect(style['--pane-focus-keyline']).toBeUndefined() // inherited from the outside app palette
  })

  it.each(PRESET_THEMES)('$name: the keyline contrasts with the app frame and terminal ink contrasts with pane backgrounds', theme => {
    const { colors, terminal } = theme
    const style = appPaneIndicatorColors(theme)
    for (const outside of [colors.bgPrimary, colors.bgSecondary, colors.bgTertiary, colors.border]) {
      expect(ratio(style['--pane-focus-keyline'], outside)).toBeGreaterThanOrEqual(3)
    }
    for (const inside of [terminal.background, colors.bgPrimary, colors.bgSecondary]) {
      expect(ratio(style['--pane-focus-color'], inside)).toBeGreaterThanOrEqual(3)
      expect(ratio(style['--pane-trace-color'], inside)).toBeGreaterThanOrEqual(3)
    }
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

  it.each(CHAT_PRESETS.map(preset => [preset.name, preset] as const))('%s: messages, answer links and timestamps are readable', (_name, preset) => {
    const { textPrimary, textLink, bgSecondary } = preset.colors
    expect(ratio(textPrimary, bgSecondary)).toBeGreaterThanOrEqual(4.5)
    expect(ratio(textPrimary, preset.outgoing)).toBeGreaterThanOrEqual(4.5)
    expect(ratio(textLink, bgSecondary)).toBeGreaterThanOrEqual(4.5)
    expect(ratio(vars(preset.id)['--chat-timestamp'], preset.canvas)).toBeGreaterThanOrEqual(4.5)
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

  it('uses the selected theme inside the chat pane and inherits the app keyline', () => {
    const theme = PRESET_THEMES.find(item => item.id === 'minimal-light') ?? PRESET_THEMES[0]
    const style = vars(theme.id)
    expect(style['--motion-accent']).toBe(theme.colors.accent)
    expect(style['--chat-focus']).toBe(theme.colors.accent)
    expect(style['--terminal-foreground']).toBe(theme.terminal.foreground)
    expect(style['--chat-trace']).toBeUndefined()
    expect(ratio(style['--pane-trace-color'], theme.colors.bgPrimary)).toBeGreaterThanOrEqual(3)
    expect(style['--pane-focus-keyline']).toBeUndefined()
    expect(style['--radius-md']).toBeUndefined()
  })

  it('following an unpaired app theme inherits its palette', () => {
    const ordinary = PRESET_THEMES.find(theme => theme.id === 'minimal-dark')!
    expect(chatAppearance(FOLLOW_APP_CHAT_THEME, [])).toBeUndefined()
    expect(chatAppearance(FOLLOW_APP_CHAT_THEME, [], ordinary)).toBeUndefined()
    expect(chatAppearance(FOLLOW_APP_CHAT_THEME, [], { ...ordinary, chatThemeId: 'missing' })).toBeUndefined()
  })

  it.each(PRESET_THEMES.filter(theme => theme.chatThemeId))('$name follows its full companion palette', theme => {
    const paired = chatAppearance(theme.chatThemeId!, [])
    expect(paired?.id).toBe(theme.chatThemeId)
    expect(paired?.bubbles).toBe(true)
    expect(chatAppearance(FOLLOW_APP_CHAT_THEME, [], theme)).toEqual(paired)
  })

  it('keeps an explicit chat palette when the app theme has a companion', () => {
    const kakao = PRESET_THEMES.find(theme => theme.chatThemeId === 'chat-kakao')!
    expect(chatAppearance('chat-paper', [], kakao)).toEqual(chatAppearance('chat-paper', []))
  })

  // A paired app theme is the same look as its chat palette, not a second choice (2026-11-24 user report:
  // "카톡 모드 (앱 테마)" stood in the chat picker right under "카톡 모드")
  it('reads a paired app theme chosen as the chat palette as its chat palette', () => {
    const kakao = PRESET_THEMES.find(theme => theme.chatThemeId === 'chat-kakao')!
    expect(chatThemeChoice(kakao.id)).toBe('chat-kakao')
    expect(chatThemeChoice('minimal-dark')).toBe('minimal-dark')
    expect(chatThemeChoice(FOLLOW_APP_CHAT_THEME)).toBe(FOLLOW_APP_CHAT_THEME)
    expect(chatAppearance(kakao.id, [])).toEqual(chatAppearance('chat-kakao', []))
  })

  it('offers each look once: paired app themes stay out of the chat choices', () => {
    const appChoices = chatPickerAppThemes([])
    expect(appChoices.some(theme => theme.chatThemeId)).toBe(false)
    expect(appChoices.some(theme => theme.id === 'minimal-dark')).toBe(true)
  })
})
