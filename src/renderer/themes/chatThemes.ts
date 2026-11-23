import type { CSSProperties } from 'react'
import { readableTextColor, visibleIndicatorColor } from '../lib/colorContrast'
import { colorSchemeFor } from '../lib/colorScheme'
import type { ThemeColors, ThemeDefinition } from '../types/theme'
import { PRESET_THEMES } from './presets'

export const FOLLOW_APP_CHAT_THEME = 'app'

type ChatColors = Pick<ThemeColors, 'bgPrimary' | 'bgSecondary' | 'bgTertiary' | 'bgHover'
  | 'textPrimary' | 'textSecondary' | 'textMuted' | 'textLink'
  | 'accent' | 'success' | 'warning' | 'error' | 'border' | 'borderStrong' | 'shadowColor'>

/**
 * Colors for what moves or marks state over the chat pane, picked per theme against its canvas:
 * focus (pane border, input, focus-visible) and trace (the light circling a working pane) need 3:1,
 * working (spinner, "작업 중" label) sits beside text so it needs 4.5:1. The trace runs just inside the
 * focus border, so it takes a different hue.
 */
interface ChatMotion {
  focus: string
  trace: string
  working: string
}

interface ChatPreset {
  id: string
  name: string
  canvas: string
  outgoing: string
  send: string
  motion: ChatMotion
  colors: ChatColors
}

export const CHAT_PRESETS: readonly ChatPreset[] = [
  {
    id: 'chat-kakao', name: '카톡 모드', canvas: '#dce8f4', outgoing: '#ffdf62', send: '#f4cf43',
    // Kakao yellow is 1.2:1 on the sky canvas, so the trace takes a deep gold and focus a blue
    motion: { focus: '#2f68b0', trace: '#a86f00', working: '#2f68b0' },
    colors: {
      bgPrimary: '#f5f8fc', bgSecondary: '#ffffff', bgTertiary: '#eaf0f7', bgHover: '#e8eff9',
      textPrimary: '#232d3e', textSecondary: '#46536a', textMuted: '#516179', textLink: '#245b9e',
      accent: '#765312', success: '#216b50', warning: '#885014', error: '#a43249',
      border: '#bdccde', borderStrong: '#8da0b9', shadowColor: 'rgb(34 56 90 / 0.18)'
    }
  },
  {
    id: 'chat-midnight', name: '미드나잇', canvas: '#131625', outgoing: '#34335b', send: '#c0b3ff',
    motion: { focus: '#c0b3ff', trace: '#8fd3ff', working: '#c0b3ff' },
    colors: {
      bgPrimary: '#171a2b', bgSecondary: '#202339', bgTertiary: '#282d47', bgHover: '#2b304c',
      textPrimary: '#f0edff', textSecondary: '#c1bfd9', textMuted: '#aaa9c5', textLink: '#a6ccff',
      accent: '#c0b3ff', success: '#93dfba', warning: '#f8cf91', error: '#f3a6b7',
      border: '#3e4260', borderStrong: '#63688c', shadowColor: 'rgb(4 5 14 / 0.48)'
    }
  },
  {
    id: 'chat-paper', name: '종이 노트', canvas: '#f3ecdb', outgoing: '#dce9d7', send: '#365c47',
    motion: { focus: '#365c47', trace: '#b0662a', working: '#365c47' },
    colors: {
      bgPrimary: '#fffcf3', bgSecondary: '#fffaf0', bgTertiary: '#ece5d2', bgHover: '#eee7d7',
      textPrimary: '#28392e', textSecondary: '#47564b', textMuted: '#526155', textLink: '#2b5b60',
      accent: '#365c47', success: '#34634a', warning: '#82501f', error: '#9b3641',
      border: '#c9c5b1', borderStrong: '#928f7a', shadowColor: 'rgb(65 56 35 / 0.18)'
    }
  },
  {
    id: 'chat-discord', name: '디스코드풍', canvas: '#272a34', outgoing: '#3d4262', send: '#a2aaff',
    motion: { focus: '#a2aaff', trace: '#9de2ce', working: '#b8beff' },
    colors: {
      bgPrimary: '#22252f', bgSecondary: '#303440', bgTertiary: '#373c4d', bgHover: '#41475c',
      textPrimary: '#f2f3fb', textSecondary: '#d4d8e6', textMuted: '#aeb5cb', textLink: '#b6c8ff',
      accent: '#a2aaff', success: '#a0e4c4', warning: '#f0c890', error: '#f4a2b2',
      border: '#474e64', borderStrong: '#69738e', shadowColor: 'rgb(9 11 20 / 0.42)'
    }
  },
  {
    id: 'chat-arcade', name: '레트로 아케이드', canvas: '#081b18', outgoing: '#15392e', send: '#c4ec83',
    motion: { focus: '#a2eccc', trace: '#ffcb73', working: '#c4ec83' },
    colors: {
      bgPrimary: '#0c211d', bgSecondary: '#102a24', bgTertiary: '#193831', bgHover: '#24473d',
      textPrimary: '#f0f8e8', textSecondary: '#cee2d0', textMuted: '#aac5b4', textLink: '#9decba',
      accent: '#c4ec83', success: '#9decba', warning: '#ffcb73', error: '#ffa89e',
      border: '#34564a', borderStrong: '#618677', shadowColor: 'rgb(1 13 10 / 0.52)'
    }
  },
  {
    id: 'chat-peach', name: '복숭아 소다', canvas: '#fff0e8', outgoing: '#ffd5cd', send: '#9e3d5b',
    motion: { focus: '#8c3d61', trace: '#ad5434', working: '#8c3d61' },
    colors: {
      bgPrimary: '#fff7f2', bgSecondary: '#fffcfa', bgTertiary: '#fbe5e0', bgHover: '#fbe6e6',
      textPrimary: '#3b2430', textSecondary: '#613d4d', textMuted: '#704a57', textLink: '#953955',
      accent: '#9e3d5b', success: '#216a50', warning: '#8b4a29', error: '#a12d4a',
      border: '#e7c2bb', borderStrong: '#bc8690', shadowColor: 'rgb(117 51 65 / 0.17)'
    }
  },
  {
    id: 'chat-neon', name: '네온 시티', canvas: '#181120', outgoing: '#4a2453', send: '#f6a1df',
    motion: { focus: '#f6a1df', trace: '#79e0ef', working: '#f6a1df' },
    colors: {
      bgPrimary: '#211629', bgSecondary: '#2c1e38', bgTertiary: '#352642', bgHover: '#442e50',
      textPrimary: '#faf1fc', textSecondary: '#e7cee9', textMuted: '#cbb0d2', textLink: '#94e8fb',
      accent: '#f6a1df', success: '#9ff0c7', warning: '#ffd19a', error: '#ff9fae',
      border: '#573759', borderStrong: '#957098', shadowColor: 'rgb(9 3 14 / 0.55)'
    }
  },
  {
    id: 'chat-amber', name: '앰버 CRT', canvas: '#1b140c', outgoing: '#4e3216', send: '#ffc66b',
    motion: { focus: '#ffc66b', trace: '#ff916b', working: '#ffd084' },
    colors: {
      bgPrimary: '#23190e', bgSecondary: '#302215', bgTertiary: '#3d2c19', bgHover: '#4b3420',
      textPrimary: '#fff3d9', textSecondary: '#f0d6a7', textMuted: '#d7b989', textLink: '#ffcf75',
      accent: '#ffc66b', success: '#c4d79a', warning: '#ffd084', error: '#ffac91',
      border: '#634724', borderStrong: '#9e7945', shadowColor: 'rgb(10 7 4 / 0.55)'
    }
  },
  {
    id: 'chat-comic', name: '흑백 만화', canvas: '#efede8', outgoing: '#dedbd4', send: '#292625',
    motion: { focus: '#706761', trace: '#3d3531', working: '#4a4240' },
    colors: {
      bgPrimary: '#f8f6f0', bgSecondary: '#fffefa', bgTertiary: '#e4e1da', bgHover: '#dcd8d0',
      textPrimary: '#262323', textSecondary: '#45403d', textMuted: '#5c5450', textLink: '#3c3837',
      accent: '#292625', success: '#354e43', warning: '#674e36', error: '#823541',
      border: '#706761', borderStrong: '#48413e', shadowColor: 'rgb(33 26 23 / 0.18)'
    }
  }
]

export function isChatThemeId(id: unknown, customThemes: readonly ThemeDefinition[]): id is string {
  return id === FOLLOW_APP_CHAT_THEME || CHAT_PRESETS.some(theme => theme.id === id)
    || PRESET_THEMES.some(theme => theme.id === id) || customThemes.some(theme => theme.id === id)
}

export function chatPresetForAppTheme(theme: ThemeDefinition | undefined) {
  return CHAT_PRESETS.find(preset => preset.id === theme?.chatThemeId)
}

export interface ChatAppearance {
  id: string
  bubbles: boolean
  style: CSSProperties
}

function paneMotionColors(focus: string, trace: string, surfaces: readonly string[]) {
  return {
    '--pane-focus-color': visibleIndicatorColor(focus, surfaces),
    '--pane-trace-color': visibleIndicatorColor(trace, surfaces)
  }
}

export function appPaneIndicatorColors({ colors, terminal }: ThemeDefinition) {
  return {
    ...paneMotionColors(colors.accent, colors.textLink, [terminal.background, colors.bgPrimary, colors.bgSecondary]),
    '--pane-focus-keyline': visibleIndicatorColor(colors.textPrimary, [colors.bgPrimary, colors.bgSecondary, colors.bgTertiary, colors.border])
  }
}

/** Apply the palette and theme's shape to chat surfaces. */
export function chatAppearance(id: string, customThemes: readonly ThemeDefinition[], appTheme?: ThemeDefinition): ChatAppearance | undefined {
  const followsApp = id === FOLLOW_APP_CHAT_THEME
  const preset = followsApp ? chatPresetForAppTheme(appTheme) : CHAT_PRESETS.find(theme => theme.id === id)
  const theme = followsApp || preset ? undefined : PRESET_THEMES.find(theme => theme.id === id) ?? customThemes.find(theme => theme.id === id)
  const colors = preset?.colors ?? theme?.colors
  if (!colors) return undefined
  const canvas = preset?.canvas ?? colors.bgPrimary
  const send = preset?.send ?? colors.accent
  const motion = preset?.motion ?? { focus: colors.accent, trace: colors.accent, working: colors.accent }
  return {
    id: preset?.id ?? id,
    bubbles: Boolean(preset),
    style: {
      colorScheme: colorSchemeFor(canvas) ?? (theme?.category === 'light' ? 'light' : 'dark'),
      ...(theme?.chrome === 'mac' && {
        '--radius-sm': 'var(--mac-radius-sm)',
        '--radius-md': 'var(--mac-radius-md)',
        '--radius-lg': 'var(--mac-radius-lg)',
        '--radius-xl': 'var(--mac-radius-xl)',
        '--radius-full': 'var(--mac-radius-full)'
      }),
      '--terminal-bg': canvas,
      '--bg-primary': colors.bgPrimary,
      '--bg-secondary': colors.bgSecondary,
      '--bg-tertiary': colors.bgTertiary,
      '--bg-hover': colors.bgHover,
      '--text-primary': colors.textPrimary,
      '--text-secondary': colors.textSecondary,
      '--text-muted': colors.textMuted,
      '--text-link': colors.textLink,
      '--accent': colors.accent,
      '--accent-muted': 'color-mix(in srgb, var(--accent) 15%, transparent)',
      '--on-accent': readableTextColor(colors.accent),
      // The inner outline and trace run over the chat canvas, header and footer. The outer
      // focus edge stays on the app palette to contrast with the surrounding pane frame.
      ...paneMotionColors(motion.focus, motion.trace, [canvas, colors.bgSecondary]),
      '--chat-focus': motion.focus,
      '--chat-timestamp': colors.textSecondary,
      '--chat-working': motion.working,
      '--motion-accent': motion.trace,
      '--chat-trace': preset ? motion.trace : undefined,
      '--terminal-foreground': preset ? colors.textPrimary : theme?.terminal.foreground,
      '--success': colors.success,
      '--warning': colors.warning,
      '--error': colors.error,
      '--error-text': colors.error,
      '--border': colors.border,
      '--border-strong': colors.borderStrong,
      '--shadow-md': `0 6px 20px ${colors.shadowColor}`,
      '--glass-float': colors.bgSecondary,
      '--glass-edge': colors.borderStrong,
      '--chat-outgoing': preset?.outgoing,
      '--chat-send': send,
      '--chat-on-send': readableTextColor(send)
    } as CSSProperties
  }
}
