import { useThemeStore } from '../stores/themeStore'
import { useUIStore } from '../stores/uiStore'
import { useShortcutsStore } from '../stores/shortcutsStore'
import { THEME_STORAGE_KEY } from './themeSync'
import type { ThemeDefinition } from '../types/theme'
import type { SurfaceStyle } from './appearance'
import {
  collectUiSettings, SHORTCUTS_KEY, UI_STORE_KEY,
  type NormalizeContext, type UiSettingsFile, type UiSettingsImport
} from './uiSettingsBackup'

/** The part of this window the settings backup needs from the stores */
export function uiSettingsContext(): NormalizeContext {
  return { shortcutIds: useShortcutsStore.getState().shortcuts.map(shortcut => shortcut.id) }
}

export function exportUiSettings(): UiSettingsFile {
  return collectUiSettings(key => localStorage.getItem(key), uiSettingsContext(), new Date())
}

/**
 * Puts checked values (parseUiSettingsFile) to use without reloading the window: a reload would
 * close every open tab. Theme, shortcuts, sidebar and zoom go through their stores and show at once;
 * the rest is read from localStorage the next time its panel opens.
 * @returns how many values were applied
 */
export function applyUiSettings(values: UiSettingsImport['values']): number {
  let applied = 0
  for (const { entry, value } of values) {
    try {
      if (entry.key === THEME_STORAGE_KEY) applyTheme(value)
      else if (entry.key === UI_STORE_KEY) applyUiStore(value)
      else if (entry.key === SHORTCUTS_KEY) applyShortcuts(value)
      else localStorage.setItem(entry.key, value)
      applied += 1
    } catch (error) {
      console.error('Could not apply a UI setting:', entry.key, error)
    }
  }
  return applied
}

function applyTheme(value: string): void {
  const state = JSON.parse(value).state as {
    currentThemeId?: string
    customThemes: ThemeDefinition[]
    surface: SurfaceStyle
    windowOpacity: number
  }
  const store = useThemeStore.getState()
  // Custom themes are added (same id: replaced); the ones already here stay
  for (const theme of state.customThemes) store.saveCustomTheme(theme)
  store.setSurface(state.surface)
  store.setWindowOpacity(state.windowOpacity)
  if (state.currentThemeId) store.setTheme(state.currentThemeId)
}

function applyUiStore(value: string): void {
  const state = JSON.parse(value).state as { sidebarMode?: 'compact' | 'expanded'; appZoom?: number }
  const store = useUIStore.getState()
  if (state.sidebarMode) store.setSidebarMode(state.sidebarMode)
  if (typeof state.appZoom === 'number') store.setAppZoom(state.appZoom)
}

/** The file's bindings replace the ones here: shortcuts not in the file go back to their defaults */
function applyShortcuts(value: string): void {
  localStorage.setItem(SHORTCUTS_KEY, value)
  useShortcutsStore.setState({ customBindings: JSON.parse(value) as Record<string, string[]> })
}
