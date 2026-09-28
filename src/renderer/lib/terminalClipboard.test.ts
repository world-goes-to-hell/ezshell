import { describe, it, expect } from 'vitest'
import { isPasteShortcut } from './terminalClipboard'

const key = (init: Partial<KeyboardEvent>) =>
  ({ type: 'keydown', ctrlKey: false, shiftKey: false, altKey: false, metaKey: false, code: '', key: '', ...init }) as KeyboardEvent

describe('isPasteShortcut', () => {
  it('matches Ctrl+V', () => {
    expect(isPasteShortcut(key({ ctrlKey: true, code: 'KeyV', key: 'v' }))).toBe(true)
  })

  it('matches Ctrl+V with the Korean input mode on', () => {
    expect(isPasteShortcut(key({ ctrlKey: true, code: 'KeyV', key: 'ㅍ' }))).toBe(true)
  })

  it.each([
    ['plain V', { code: 'KeyV', key: 'v' }],
    ['Ctrl+Alt+V', { ctrlKey: true, altKey: true, code: 'KeyV' }],
    ['the keyup of Ctrl+V', { type: 'keyup', ctrlKey: true, code: 'KeyV' }],
    ['Ctrl+C', { ctrlKey: true, code: 'KeyC', key: 'c' }]
  ])('does not match %s', (_label, init) => {
    expect(isPasteShortcut(key(init))).toBe(false)
  })
})
