import { describe, expect, it } from 'vitest'
import { matchesBinding } from './shortcutMatch'

const press = (code: string, mods: Partial<{ ctrlKey: boolean; metaKey: boolean; altKey: boolean; shiftKey: boolean }> = {}) => ({
  key: '', code, ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, ...mods
})

describe('matching a key press to a binding', () => {
  it('needs exactly the binding\'s modifiers', () => {
    const keys = ['Ctrl', 'Shift', 'F11']
    expect(matchesBinding(press('F11', { ctrlKey: true, shiftKey: true }), keys, false)).toBe(true)
    expect(matchesBinding(press('F11', { ctrlKey: true }), keys, false)).toBe(false)
    expect(matchesBinding(press('F11', { ctrlKey: true, shiftKey: true, altKey: true }), keys, false)).toBe(false)
    expect(matchesBinding(press('F10', { ctrlKey: true, shiftKey: true }), keys, false)).toBe(false)
  })

  it('reads letters by their place, whatever the input language', () => {
    expect(matchesBinding({ ...press('KeyJ', { ctrlKey: true, shiftKey: true }), key: 'ㅓ' }, ['Ctrl', 'Shift', 'J'], false)).toBe(true)
  })

  it('takes Command for Ctrl on macOS', () => {
    expect(matchesBinding(press('KeyJ', { metaKey: true, shiftKey: true }), ['Ctrl', 'Shift', 'J'], true)).toBe(true)
    expect(matchesBinding(press('KeyJ', { ctrlKey: true, shiftKey: true }), ['Ctrl', 'Shift', 'J'], true)).toBe(false)
  })
})
