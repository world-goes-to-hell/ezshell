import type { CSSProperties } from 'react'
import { readableTextColor } from '../lib/colorContrast'
import { colorSchemeFor } from '../lib/colorScheme'
import type { ThemeColors, ThemeDefinition } from '../types/theme'
import { PRESET_THEMES } from './presets'

export const FOLLOW_APP_CHAT_THEME = 'app'

type ChatColors = Pick<ThemeColors, 'bgPrimary' | 'bgSecondary' | 'bgTertiary' | 'bgHover'
  | 'textPrimary' | 'textSecondary' | 'textMuted' | 'textLink'
  | 'accent' | 'success' | 'warning' | 'error' | 'border' | 'borderStrong' | 'shadowColor'>

interface ChatPreset {
  id: string
  name: string
  canvas: string
  outgoing: string
  send: string
  colors: ChatColors
}

export const CHAT_PRESETS: readonly ChatPreset[] = [
  {
    id: 'chat-kakao', name: '카톡 모드', canvas: '#dce8f4', outgoing: '#ffdf62', send: '#f4cf43',
    colors: {
      bgPrimary: '#f5f8fc', bgSecondary: '#ffffff', bgTertiary: '#eaf0f7', bgHover: '#e8eff9',
      textPrimary: '#232d3e', textSecondary: '#46536a', textMuted: '#516179', textLink: '#245b9e',
      accent: '#765312', success: '#216b50', warning: '#885014', error: '#a43249',
      border: '#bdccde', borderStrong: '#8da0b9', shadowColor: 'rgb(34 56 90 / 0.18)'
    }
  },
  {
    id: 'chat-midnight', name: '미드나잇', canvas: '#131625', outgoing: '#34335b', send: '#c0b3ff',
    colors: {
      bgPrimary: '#171a2b', bgSecondary: '#202339', bgTertiary: '#282d47', bgHover: '#2b304c',
      textPrimary: '#f0edff', textSecondary: '#c1bfd9', textMuted: '#aaa9c5', textLink: '#a6ccff',
      accent: '#c0b3ff', success: '#93dfba', warning: '#f8cf91', error: '#f3a6b7',
      border: '#3e4260', borderStrong: '#63688c', shadowColor: 'rgb(4 5 14 / 0.48)'
    }
  },
  {
    id: 'chat-paper', name: '종이 노트', canvas: '#f3ecdb', outgoing: '#dce9d7', send: '#365c47',
    colors: {
      bgPrimary: '#fffcf3', bgSecondary: '#fffaf0', bgTertiary: '#ece5d2', bgHover: '#eee7d7',
      textPrimary: '#28392e', textSecondary: '#47564b', textMuted: '#526155', textLink: '#2b5b60',
      accent: '#365c47', success: '#34634a', warning: '#82501f', error: '#9b3641',
      border: '#c9c5b1', borderStrong: '#928f7a', shadowColor: 'rgb(65 56 35 / 0.18)'
    }
  }
]

export function isChatThemeId(id: unknown, customThemes: readonly ThemeDefinition[]): id is string {
  return id === FOLLOW_APP_CHAT_THEME || CHAT_PRESETS.some(theme => theme.id === id)
    || PRESET_THEMES.some(theme => theme.id === id) || customThemes.some(theme => theme.id === id)
}

export interface ChatAppearance {
  accent: string
  bubbles: boolean
  style: CSSProperties
}

/** Apply the palette to the chat surfaces without changing the document or xterm theme. */
export function chatAppearance(id: string, customThemes: readonly ThemeDefinition[]): ChatAppearance | undefined {
  if (id === FOLLOW_APP_CHAT_THEME) return undefined
  const preset = CHAT_PRESETS.find(theme => theme.id === id)
  const theme = PRESET_THEMES.find(theme => theme.id === id) ?? customThemes.find(theme => theme.id === id)
  const colors = preset?.colors ?? theme?.colors
  if (!colors) return undefined
  const canvas = preset?.canvas ?? colors.bgPrimary
  const send = preset?.send ?? colors.accent
  return {
    accent: colors.accent,
    bubbles: Boolean(preset),
    style: {
      colorScheme: colorSchemeFor(canvas) ?? (theme?.category === 'light' ? 'light' : 'dark'),
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
