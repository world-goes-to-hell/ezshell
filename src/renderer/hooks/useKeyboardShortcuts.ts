import { useEffect, useCallback } from 'react'
import { useShortcutsStore } from '../stores/shortcutsStore'

export type ShortcutAction =
  | 'openCommandPalette'
  | 'newConnection'
  | 'openSettings'
  | 'openSnippetManager'
  | 'toggleFullscreen'
  | 'lockApp'
  | 'closeCurrentTerminal'
  | 'zoomIn'
  | 'zoomOut'
  | 'resetZoom'
  | 'clearTerminal'
  | 'toggleSftp'
  | 'toggleZenMode'
  | 'toggleSidebar'
  | 'nextTab'
  | 'prevTab'
  | 'jumpToTab1'
  | 'jumpToTab2'
  | 'jumpToTab3'
  | 'jumpToTab4'
  | 'jumpToTab5'
  | 'jumpToTab6'
  | 'jumpToTab7'
  | 'jumpToTab8'
  | 'jumpToTab9'

export interface ShortcutHandlers {
  [key: string]: () => void
}

/**
 * Hook to register global keyboard shortcuts
 * @param handlers - Map of action names to handler functions
 * @param enabled - Whether shortcuts are enabled (default: true)
 */
export function useKeyboardShortcuts(
  handlers: ShortcutHandlers,
  enabled: boolean = true
) {
  const { shortcuts, customBindings } = useShortcutsStore()

  const matchesShortcut = useCallback((event: KeyboardEvent, keys: string[]): boolean => {
    if (keys.length === 0) return false

    // Build expected modifier state
    const expectedModifiers = {
      ctrl: false,
      shift: false,
      alt: false,
      meta: false
    }

    let mainKey = ''

    for (const key of keys) {
      const lower = key.toLowerCase()
      if (lower === 'ctrl' || lower === 'control') {
        expectedModifiers.ctrl = true
      } else if (lower === 'shift') {
        expectedModifiers.shift = true
      } else if (lower === 'alt') {
        expectedModifiers.alt = true
      } else if (lower === 'meta' || lower === 'cmd' || lower === 'command') {
        expectedModifiers.meta = true
      } else {
        mainKey = key
      }
    }

    // Check modifiers match
    if (event.ctrlKey !== expectedModifiers.ctrl) return false
    if (event.shiftKey !== expectedModifiers.shift) return false
    if (event.altKey !== expectedModifiers.alt) return false
    if (event.metaKey !== expectedModifiers.meta) return false

    // Check main key matches
    if (!mainKey) return false

    // Handle special keys
    const eventKey = event.key.toLowerCase()
    const expectedKey = mainKey.toLowerCase()

    // Special key mappings
    const keyMap: Record<string, string[]> = {
      '+': ['plus', '+', '='],
      '-': ['minus', '-', '_'],
      ',': ['comma', ','],
      '0': ['0'],
      '1': ['1'], '2': ['2'], '3': ['3'], '4': ['4'], '5': ['5'],
      '6': ['6'], '7': ['7'], '8': ['8'], '9': ['9']
    }

    if (keyMap[expectedKey]) {
      return keyMap[expectedKey].includes(eventKey) || keyMap[expectedKey].includes(event.key)
    }

    // Direct comparison for most keys
    return eventKey === expectedKey || event.key === mainKey
  }, [])

  useEffect(() => {
    if (!enabled) return

    const handleKeyDown = (event: KeyboardEvent) => {
      // Don't handle shortcuts when typing in inputs (except command palette)
      const target = event.target as HTMLElement
      const isInput = target.tagName === 'INPUT' ||
                      target.tagName === 'TEXTAREA' ||
                      target.isContentEditable

      // Allow command palette shortcut even in inputs
      const commandPaletteShortcut = shortcuts.find(s => s.action === 'openCommandPalette')
      if (commandPaletteShortcut) {
        const effectiveKeys = customBindings[commandPaletteShortcut.id] || commandPaletteShortcut.keys
        if (matchesShortcut(event, effectiveKeys)) {
          event.preventDefault()
          const handler = handlers[commandPaletteShortcut.action]
          if (handler) {
            handler()
            return
          }
        }
      }

      // Skip other shortcuts if in input
      if (isInput) return

      // Check each shortcut
      for (const shortcut of shortcuts) {
        const effectiveKeys = customBindings[shortcut.id] || shortcut.keys

        if (matchesShortcut(event, effectiveKeys)) {
          const handler = handlers[shortcut.action]
          if (handler) {
            event.preventDefault()
            handler()
            return
          }
        }
      }
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [enabled, shortcuts, customBindings, handlers, matchesShortcut])
}
