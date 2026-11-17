// Which modifier keys count for an app shortcut. Bindings are written with "Ctrl" (Ctrl+P, Ctrl+W).
// On macOS that means the Command key: Cmd+P, Cmd+W. The Control key is left to the shell there
// (Ctrl+W deletes a word, Ctrl+P is "previous command"), as in every Mac terminal.
// One exception: Cmd+Tab switches apps in macOS and never reaches the app, so a binding on Tab
// keeps the Control key (Ctrl+Tab, as in other Mac apps with tabs).

import { isMacPlatform } from './defaultTheme'

export interface ModifierKeys {
  ctrlKey: boolean
  metaKey: boolean
}

export interface ExpectedModifiers {
  ctrl: boolean
  meta: boolean
}

/** Whether the Ctrl / Command part of a binding matches the keys held down */
export function primaryModifiersMatch(event: ModifierKeys, expected: ExpectedModifiers, mainKey: string, isMac: boolean): boolean {
  if (!isMac || mainKey.toLowerCase() === 'tab') {
    return event.ctrlKey === expected.ctrl && event.metaKey === expected.meta
  }
  const wantsCommand = expected.ctrl || expected.meta
  return event.metaKey === wantsCommand && !event.ctrlKey
}

let cachedIsMac: boolean | null = null

/** Whether the app runs on macOS (false where there is no browser to ask, as in tests) */
export function isMac(): boolean {
  if (cachedIsMac !== null) return cachedIsMac
  try {
    const nav = navigator as Navigator & { userAgentData?: { platform?: string } }
    cachedIsMac = isMacPlatform(nav.userAgentData?.platform || nav.platform)
  } catch {
    cachedIsMac = false
  }
  return cachedIsMac
}

/** Each key of a binding as it is shown: "Ctrl" reads as "⌘" on macOS (not for Tab, see above) */
export function shortcutKeyLabels(keys: readonly string[], onMac: boolean = isMac()): string[] {
  const isTab = keys.some(key => key.toLowerCase() === 'tab')
  return keys.map((key) => {
    if (!onMac) return key
    const lower = key.toLowerCase()
    if ((lower === 'ctrl' || lower === 'control') && !isTab) return '⌘'
    if (lower === 'meta' || lower === 'cmd' || lower === 'command') return '⌘'
    if (lower === 'alt') return '⌥'
    if (lower === 'shift') return '⇧'
    return key
  })
}

/** A binding as one string: 'Ctrl+Shift+P', and '⌘ ⇧ P' on macOS */
export function shortcutLabel(keys: readonly string[], onMac: boolean = isMac()): string {
  return shortcutKeyLabels(keys, onMac).join(onMac ? ' ' : '+')
}
