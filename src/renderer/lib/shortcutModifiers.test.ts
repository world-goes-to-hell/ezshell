import { describe, it, expect } from 'vitest'
import { primaryModifiersMatch, shortcutLabel } from './shortcutModifiers'

const keys = (ctrlKey: boolean, metaKey: boolean) => ({ ctrlKey, metaKey })
const CTRL = { ctrl: true, meta: false }
const NONE = { ctrl: false, meta: false }

describe('primaryModifiersMatch', () => {
  it('on Windows and Linux: Ctrl means the Control key', () => {
    expect(primaryModifiersMatch(keys(true, false), CTRL, 'P', false)).toBe(true)
    expect(primaryModifiersMatch(keys(false, true), CTRL, 'P', false)).toBe(false)
    expect(primaryModifiersMatch(keys(false, false), NONE, 'F11', false)).toBe(true)
    expect(primaryModifiersMatch(keys(true, false), NONE, 'F11', false)).toBe(false)
  })

  it('on macOS: a Ctrl binding is pressed with Command', () => {
    expect(primaryModifiersMatch(keys(false, true), CTRL, 'P', true)).toBe(true)
    expect(primaryModifiersMatch(keys(false, true), CTRL, 'W', true)).toBe(true)
  })

  it('on macOS: the Control key is left to the shell', () => {
    expect(primaryModifiersMatch(keys(true, false), CTRL, 'W', true)).toBe(false)
    expect(primaryModifiersMatch(keys(true, true), CTRL, 'W', true)).toBe(false)
  })

  it('on macOS: a binding without Ctrl does not fire with Command or Control held', () => {
    expect(primaryModifiersMatch(keys(false, false), NONE, 'F11', true)).toBe(true)
    expect(primaryModifiersMatch(keys(false, true), NONE, 'F11', true)).toBe(false)
    expect(primaryModifiersMatch(keys(true, false), NONE, 'F11', true)).toBe(false)
  })

  it('on macOS: Tab keeps the Control key (Cmd+Tab belongs to the system)', () => {
    expect(primaryModifiersMatch(keys(true, false), CTRL, 'Tab', true)).toBe(true)
    expect(primaryModifiersMatch(keys(false, true), CTRL, 'Tab', true)).toBe(false)
  })

  it('on macOS: a binding written with Command works too', () => {
    expect(primaryModifiersMatch(keys(false, true), { ctrl: false, meta: true }, 'K', true)).toBe(true)
  })
})

describe('shortcutLabel', () => {
  it('shows the binding as written off macOS', () => {
    expect(shortcutLabel(['Ctrl', 'Shift', 'P'], false)).toBe('Ctrl+Shift+P')
  })

  it('shows Mac symbols on macOS, keeping Ctrl for Tab', () => {
    expect(shortcutLabel(['Ctrl', 'Shift', 'P'], true)).toBe('⌘ ⇧ P')
    expect(shortcutLabel(['Ctrl', 'Tab'], true)).toBe('Ctrl Tab')
    expect(shortcutLabel(['F11'], true)).toBe('F11')
  })
})
