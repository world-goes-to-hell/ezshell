import { useMemo, type CSSProperties } from 'react'
import { RiPaletteLine } from 'react-icons/ri'
import { useThemeStore } from '../../stores/themeStore'
import { CHAT_PRESETS, FOLLOW_APP_CHAT_THEME, chatPresetForAppTheme } from '../../themes/chatThemes'
import { PRESET_THEMES } from '../../themes/presets'
import { SelectMenu } from '../ui/SelectMenu'
import './AgentChatThemePicker.css'

export function AgentChatThemePicker({ toolbar = false, menuStyle }: { toolbar?: boolean; menuStyle?: CSSProperties }) {
  const value = useThemeStore(state => state.chatThemeId)
  const setTheme = useThemeStore(state => state.setChatTheme)
  const customThemes = useThemeStore(state => state.customThemes)
  const appTheme = useThemeStore(state => state.getCurrentTheme())
  const options = useMemo(() => [
    { value: FOLLOW_APP_CHAT_THEME, label: `앱 테마 따르기 · ${chatPresetForAppTheme(appTheme)?.name ?? appTheme.name}` },
    ...CHAT_PRESETS.map(preset => ({
      value: preset.id,
      label: preset.name,
      icon: <Swatch canvas={preset.canvas} accent={preset.outgoing} />
    })),
    ...[...PRESET_THEMES, ...customThemes].map(theme => ({
      value: theme.id,
      label: theme.chatThemeId ? `${theme.name} (앱 테마)` : theme.name,
      icon: <Swatch canvas={theme.preview.primary} accent={theme.preview.accent} />
    }))
  ], [appTheme, customThemes])

  return <SelectMenu ariaLabel="채팅 테마" value={value} options={options} onChange={setTheme}
    icon={<RiPaletteLine size={16} aria-hidden />} iconOnly={toolbar}
    size={toolbar ? 'compact' : 'field'} className={toolbar ? 'agent-chat-theme-trigger' : undefined} menuStyle={menuStyle} />
}

function Swatch({ canvas, accent }: { canvas: string; accent: string }) {
  return <span className="agent-chat-theme-swatch" style={{ backgroundColor: canvas }} aria-hidden>
    <span style={{ backgroundColor: accent }} />
  </span>
}
