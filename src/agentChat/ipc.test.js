import { describe, expect, it } from 'vitest'
import { cleanChatText } from './ipc.js'

describe('text the chat view may send', () => {
  it('keeps lines and tabs, unifies line ends and trims the ends', () => {
    expect(cleanChatText('\n첫 줄\r\n\t둘째 줄\r셋째  \n')).toBe('첫 줄\n\t둘째 줄\n셋째')
  })

  it('refuses control characters: an ESC could end the bracketed paste and type keys', () => {
    expect(cleanChatText('a\x1b[201~rm -rf ~\r')).toBeNull()
    expect(cleanChatText('a\x03')).toBeNull()
    expect(cleanChatText('a\u009b31m')).toBeNull()
  })

  it('refuses empty, too long and non-text values', () => {
    expect(cleanChatText('   \n ')).toBeNull()
    expect(cleanChatText('x'.repeat(16_001))).toBeNull()
    expect(cleanChatText(42)).toBeNull()
  })
})
