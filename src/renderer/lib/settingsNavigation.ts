// Opens the settings window at a tab from anywhere in the main window (the JDK notice of a run preset
// opens 개발 도구 with the version it needs). App.tsx opens the window, SettingsModal picks the tab.

export const OPEN_SETTINGS_EVENT = 'ezshell:open-settings'

export interface OpenSettings {
  /** A top tab of SettingsModal ('theme', 'mcp', 'development' …) */
  tab: string
  /** 개발 도구: the JDK version to have picked for 받기 */
  jdkFeature?: number
}

/** The JDK version a request asked for, taken once by the JDK settings when they open */
let pendingJdkFeature: number | null = null

export function openSettingsTab(tab: string, options: Omit<OpenSettings, 'tab'> = {}) {
  if (typeof options.jdkFeature === 'number') pendingJdkFeature = options.jdkFeature
  window.dispatchEvent(new CustomEvent<OpenSettings>(OPEN_SETTINGS_EVENT, { detail: { tab, ...options } }))
}

export function takePendingJdkFeature(): number | null {
  const feature = pendingJdkFeature
  pendingJdkFeature = null
  return feature
}
