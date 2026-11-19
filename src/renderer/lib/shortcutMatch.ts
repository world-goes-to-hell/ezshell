import { mainKeyOf, normalizeKeys } from './shortcutCapture'
import { isMac, primaryModifiersMatch } from './shortcutModifiers'

export interface KeyEventLike {
  key: string
  code: string
  ctrlKey: boolean
  metaKey: boolean
  altKey: boolean
  shiftKey: boolean
}

/**
 * Whether a key press is a binding (['Ctrl', 'Shift', 'F11']), by the key's place (`code`, so a Korean
 * input mode does not matter) and exactly these modifiers. For views that take a shortcut themselves
 * because the key is pressed inside a terminal or a text box (the app-wide handler skips those).
 */
export function matchesBinding(event: KeyEventLike, keys: readonly string[], onMac: boolean = isMac()): boolean {
  const binding = normalizeKeys(keys)
  const main = binding[binding.length - 1]
  const pressed = mainKeyOf(event)
  if (!main || !pressed || pressed.toLowerCase() !== main.toLowerCase()) return false
  return primaryModifiersMatch(event, { ctrl: binding.includes('Ctrl'), meta: false }, main, onMac) &&
    event.altKey === binding.includes('Alt') &&
    event.shiftKey === binding.includes('Shift')
}
