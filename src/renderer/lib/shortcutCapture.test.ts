import { describe, it, expect } from 'vitest'
import { captureKeys, mainKeyOf, normalizeKeys, sameBinding, bindingProblem, findConflict, parseCustomBindings, type KeyPress } from './shortcutCapture'

const press = (code: string, key: string, mods: Partial<KeyPress> = {}): KeyPress =>
  ({ code, key, ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, ...mods })

describe('mainKeyOf', () => {
  it('reads letters and digits from the key position, whatever the input mode', () => {
    expect(mainKeyOf({ code: 'KeyP', key: 'ㅔ' })).toBe('P')
    expect(mainKeyOf({ code: 'Digit1', key: '!' })).toBe('1')
    expect(mainKeyOf({ code: 'F11', key: 'F11' })).toBe('F11')
    expect(mainKeyOf({ code: 'Comma', key: ',' })).toBe(',')
    expect(mainKeyOf({ code: 'Equal', key: '=' })).toBe('+')
  })

  it('gives nothing for keys that cannot be bound', () => {
    for (const code of ['Enter', 'Space', 'Escape', 'Backspace', 'Delete']) expect(mainKeyOf({ code, key: code })).toBeNull()
  })
})

describe('captureKeys', () => {
  it('waits while only modifiers are down', () => {
    expect(captureKeys(press('ControlLeft', 'Control', { ctrlKey: true }), false)).toEqual({ kind: 'waiting' })
    expect(captureKeys(press('ShiftLeft', 'Shift', { shiftKey: true }), false)).toEqual({ kind: 'waiting' })
  })

  it('reads a combination on Windows', () => {
    expect(captureKeys(press('KeyK', 'k', { ctrlKey: true }), false)).toEqual({ kind: 'keys', keys: ['Ctrl', 'K'] })
    expect(captureKeys(press('KeyP', 'P', { ctrlKey: true, shiftKey: true }), false)).toEqual({ kind: 'keys', keys: ['Ctrl', 'Shift', 'P'] })
    expect(captureKeys(press('F9', 'F9'), false)).toEqual({ kind: 'keys', keys: ['F9'] })
    expect(captureKeys(press('KeyJ', 'j', { altKey: true }), false)).toEqual({ kind: 'keys', keys: ['Alt', 'J'] })
  })

  it('on macOS stores Command as the main modifier', () => {
    expect(captureKeys(press('KeyK', 'k', { metaKey: true }), true)).toEqual({ kind: 'keys', keys: ['Ctrl', 'K'] })
  })

  it('on macOS refuses Control (the shell\'s key), except with Tab', () => {
    expect(captureKeys(press('KeyK', 'k', { ctrlKey: true }), true).kind).toBe('invalid')
    expect(captureKeys(press('Tab', 'Tab', { ctrlKey: true }), true)).toEqual({ kind: 'keys', keys: ['Ctrl', 'Tab'] })
    expect(captureKeys(press('Tab', 'Tab', { metaKey: true }), true).kind).toBe('invalid')
  })

  it('refuses a plain key, clipboard keys and keys that cannot be bound', () => {
    expect(captureKeys(press('KeyK', 'k'), false).kind).toBe('invalid')
    expect(captureKeys(press('KeyK', 'K', { shiftKey: true }), false).kind).toBe('invalid')
    expect(captureKeys(press('KeyC', 'c', { ctrlKey: true }), false).kind).toBe('invalid')
    expect(captureKeys(press('KeyV', 'v', { ctrlKey: true }), false).kind).toBe('invalid')
    expect(captureKeys(press('Enter', 'Enter', { ctrlKey: true }), false).kind).toBe('invalid')
    expect(captureKeys(press('KeyK', 'k', { metaKey: true }), false).kind).toBe('invalid')
  })

  it('allows clipboard letters once Shift or Alt is added', () => {
    expect(captureKeys(press('KeyC', 'C', { ctrlKey: true, shiftKey: true }), false).kind).toBe('keys')
  })

  it('on macOS refuses the menu keys', () => {
    expect(captureKeys(press('KeyQ', 'q', { metaKey: true }), true).kind).toBe('invalid')
    expect(bindingProblem(['Ctrl', 'Q'], false)).toBeNull()
  })
})

describe('normalizeKeys and sameBinding', () => {
  it('puts modifiers in a fixed order and upper-cases a letter', () => {
    expect(normalizeKeys(['shift', 'p', 'Ctrl'])).toEqual(['Ctrl', 'Shift', 'P'])
    expect(normalizeKeys(['Cmd', 'k'])).toEqual(['Ctrl', 'K'])
    expect(sameBinding(['Shift', 'Ctrl', 'p'], ['Ctrl', 'Shift', 'P'])).toBe(true)
    expect(sameBinding(['Ctrl', 'P'], ['Ctrl', 'Shift', 'P'])).toBe(false)
  })
})

describe('findConflict', () => {
  const shortcuts = [
    { id: 'palette', keys: ['Ctrl', 'P'], description: '명령 팔레트' },
    { id: 'new', keys: ['Ctrl', 'N'], description: '새 연결' }
  ]

  it('finds another shortcut with the same binding, by its effective keys', () => {
    expect(findConflict(shortcuts, {}, 'new', ['Ctrl', 'P'])?.id).toBe('palette')
    expect(findConflict(shortcuts, { palette: ['Ctrl', 'K'] }, 'new', ['Ctrl', 'P'])).toBeNull()
    expect(findConflict(shortcuts, { palette: ['Ctrl', 'K'] }, 'new', ['Ctrl', 'K'])?.id).toBe('palette')
  })

  it('does not count the shortcut being changed', () => {
    expect(findConflict(shortcuts, {}, 'palette', ['Ctrl', 'P'])).toBeNull()
  })
})

describe('parseCustomBindings', () => {
  const ids = ['palette', 'new']
  it('reads saved bindings of known shortcuts', () => {
    expect(parseCustomBindings('{"palette":["ctrl","k"],"gone":["Ctrl","J"]}', ids)).toEqual({ palette: ['Ctrl', 'K'] })
  })

  it('drops anything unreadable', () => {
    expect(parseCustomBindings('{broken', ids)).toEqual({})
    expect(parseCustomBindings('[1,2]', ids)).toEqual({})
    expect(parseCustomBindings('{"palette":"Ctrl+K","new":[1,2]}', ids)).toEqual({})
    expect(parseCustomBindings(null, ids)).toEqual({})
  })
})
