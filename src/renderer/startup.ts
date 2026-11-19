import { useThemeStore } from './stores/themeStore'

// Shares the app's storage origin, so presets and saved custom themes resolve the same way.
const { colors } = useThemeStore.getState().getCurrentTheme()
const root = document.documentElement
root.style.setProperty('--startup-accent', colors.accent)
root.style.setProperty('--startup-text', colors.textPrimary)
root.style.setProperty('--startup-muted', colors.textSecondary)
root.style.setProperty('--startup-shadow', colors.bgPrimary)
document.querySelector<HTMLElement>('.startup')!.hidden = false
