import { describe, expect, it } from 'vitest'
import { hasTypedInput } from './terminalReplies'

describe('hasTypedInput', () => {
  it('does not count focus reports, mouse reports or query answers as typing', () => {
    for (const data of [
      '\x1b[I', '\x1b[O', '\x1b[O\x1b[I',
      '\x1b[<64;10;5M', '\x1b[<65;10;5M\x1b[<65;10;6M', '\x1b[<0;3;4M\x1b[<0;3;4m',
      '\x1b[M`!!', '\x1b[64;10;5M',
      '\x1b[12;40R', '\x1b[?1;2c', '\x1b[>0;276;0c', '\x1b[?2004;1$y',
      '\x1b[8;24;80t', '\x1b]11;rgb:1e1e/1e1e/1e1e\x07', '\x1b]10;rgb:ffff/ffff/ffff\x1b\\', '\x1bP1$r0m\x1b\\',
      ''
    ]) expect(hasTypedInput(data), JSON.stringify(data)).toBe(false)
  })

  it('counts keys and pastes, also next to a report', () => {
    for (const data of [
      '1', '\r', ' ', '\x1b', '\x1b[A', '\x1b[B', '\x1b[Z', '\x1bOP', '\x7f', '\x03',
      '\x1b[200~text\x1b[201~', '\x1b[O2', 'a\x1b[<64;1;1M'
    ]) expect(hasTypedInput(data), JSON.stringify(data)).toBe(true)
  })
})
