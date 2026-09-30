import { describe, it, expect } from 'vitest'
import { resolveFileListShortcut, type ShortcutKeyEvent } from './fileListShortcuts'

const key = (k: string, extra: Partial<ShortcutKeyEvent> = {}): ShortcutKeyEvent => ({
  key: k,
  code: '',
  ctrlKey: false,
  shiftKey: false,
  altKey: false,
  metaKey: false,
  ...extra
})

describe('resolveFileListShortcut', () => {
  it.each([
    [key('F2'), 'rename'],
    [key('Delete'), 'delete'],
    [key('F5'), 'refresh'],
    [key('Home'), 'first'],
    [key('End'), 'last'],
    [key('Escape'), 'clearSelection'],
    [key('ArrowLeft', { altKey: true }), 'back'],
    [key('ArrowRight', { altKey: true }), 'forward'],
    [key('ArrowUp', { altKey: true }), 'up'],
    [key('N', { code: 'KeyN', ctrlKey: true, shiftKey: true }), 'newFolder'],
    [key('l', { code: 'KeyL', ctrlKey: true }), 'focusPath'],
    [key('a', { code: 'KeyA', ctrlKey: true }), 'selectAll'],
    [key('f', { code: 'KeyF', ctrlKey: true }), 'swallow'],
    [key('w', { code: 'KeyW', ctrlKey: true }), 'swallow']
  ] as const)('%o -> %s', (event, expected) => {
    expect(resolveFileListShortcut(event)).toBe(expected)
  })

  it('matches letter shortcuts by physical key so the Korean IME does not break them', () => {
    expect(resolveFileListShortcut(key('ㅜ', { code: 'KeyN', ctrlKey: true, shiftKey: true }))).toBe('newFolder')
    expect(resolveFileListShortcut(key('ㅣ', { code: 'KeyL', ctrlKey: true }))).toBe('focusPath')
  })

  it('ignores keys with extra modifiers', () => {
    expect(resolveFileListShortcut(key('Delete', { shiftKey: true }))).toBeNull()
    expect(resolveFileListShortcut(key('F2', { ctrlKey: true }))).toBeNull()
    expect(resolveFileListShortcut(key('n', { code: 'KeyN', ctrlKey: true }))).toBeNull()
    expect(resolveFileListShortcut(key('ArrowLeft', { altKey: true, shiftKey: true }))).toBeNull()
  })

  it('leaves plain arrows and Enter to the existing handler', () => {
    expect(resolveFileListShortcut(key('ArrowLeft'))).toBeNull()
    expect(resolveFileListShortcut(key('Enter'))).toBeNull()
    expect(resolveFileListShortcut(key('Backspace'))).toBeNull()
  })
})
