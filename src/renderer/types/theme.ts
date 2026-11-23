// Theme type definitions

export type ThemeCategory = 'dark' | 'light' | 'special'

export interface QuickCaptureTheme {
  background: string
  surface: string
  border: string
  text: string
  muted: string
  accent: string
  onAccent: string
  focus: string
  danger: string
  radius: string
  panelRadius: string
  font: string
  scheme: 'light' | 'dark'
}

export interface ThemeColors {
  // Background colors
  bgPrimary: string
  bgSecondary: string
  bgTertiary: string
  bgHover: string
  bgActive: string
  bgModifierHover: string
  bgModifierSelected: string

  // Text colors
  textPrimary: string
  textSecondary: string
  textMuted: string
  textLink: string

  // Brand/Accent colors
  accent: string
  accentHover: string
  accentActive: string

  // Status colors
  success: string
  warning: string
  error: string
  info: string

  // Borders
  border: string
  borderStrong: string

  // Shadows
  shadowColor: string
  glowColor: string
}

export interface TerminalColors {
  background: string
  foreground: string
  cursor: string
  cursorAccent: string
  selectionBackground: string
  black: string
  red: string
  green: string
  yellow: string
  blue: string
  magenta: string
  cyan: string
  white: string
  brightBlack: string
  brightRed: string
  brightGreen: string
  brightYellow: string
  brightBlue: string
  brightMagenta: string
  brightCyan: string
  brightWhite: string
}

export interface ThemePreview {
  primary: string
  secondary: string
  accent: string
}

export interface ThemeDefinition {
  id: string
  name: string
  category: ThemeCategory
  colors: ThemeColors
  terminal: TerminalColors
  preview: ThemePreview
  /** Built-in chat palette paired with this preset. Theme selection reads its own setting. */
  chatThemeId?: string
  /** Window-chrome style beyond colors. 'mac': rounded corners, traffic-light buttons on the left (presets only) */
  chrome?: 'mac'
  // Special effects
  effects?: {
    glow?: boolean
    scanlines?: boolean
  }
}
