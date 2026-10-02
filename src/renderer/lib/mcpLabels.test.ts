import { describe, it, expect } from 'vitest'
import { ALERT_LEVEL_OPTIONS, OUTCOME_LABELS, RISK_LABELS, formatAuditTime, maskToken, maskRegisterCommand, parsePort, revealHiddenChars, revealPath, secondsLeft } from './mcpLabels'

describe('mcpLabels', () => {
  it('labels every risk level and outcome', () => {
    expect(RISK_LABELS).toEqual({ low: '낮음', medium: '중간', danger: '위험', forbidden: '차단' })
    expect(Object.keys(OUTCOME_LABELS).sort()).toEqual(['approved', 'blocked', 'cancelled', 'denied', 'executed', 'expired', 'failed'])
  })

  it('offers the alert levels with danger first as the default', () => {
    expect(ALERT_LEVEL_OPTIONS.map(option => option.value)).toEqual(['danger', 'medium', 'all'])
  })

  it('masks all but the ends of a token', () => {
    expect(maskToken('ab'.repeat(32))).toBe(`abab${'•'.repeat(12)}abab`)
    expect(maskToken('short')).toBe('••••')
    expect(maskToken('')).toBe('••••')
  })

  it('masks the token inside the register command, and shows only a mask while it is hidden (app locked)', () => {
    const token = 'ab'.repeat(32)
    const command = `claude mcp add x --header "Authorization: Bearer ${token}"`
    expect(maskRegisterCommand(command, token, maskToken(token))).toBe(`claude mcp add x --header "Authorization: Bearer ${maskToken(token)}"`)
    expect(maskRegisterCommand(command, token, token)).toBe(command)
    expect(maskRegisterCommand('', '', '••••')).toBe('••••')
    expect(maskRegisterCommand(command, '', '••••')).toBe('••••')
  })

  it('accepts only whole ports between 1024 and 65535', () => {
    expect(parsePort('47521')).toBe(47521)
    expect(parsePort(' 50000 ')).toBe(50000)
    expect(parsePort('80')).toBeNull()
    expect(parsePort('70000')).toBeNull()
    expect(parsePort('47.5')).toBeNull()
    expect(parsePort('abc')).toBeNull()
  })

  it('counts down whole seconds without going negative', () => {
    expect(secondsLeft(60_000, 0)).toBe(60)
    expect(secondsLeft(60_000, 59_001)).toBe(1)
    expect(secondsLeft(60_000, 61_000)).toBe(0)
  })

  it('formats audit times and keeps unknown text', () => {
    expect(formatAuditTime('2026-10-01T01:02:03.000Z')).toMatch(/^\d{1,2}\/\d{1,2} \d{2}:\d{2}:\d{2}$/)
    expect(formatAuditTime('nope')).toBe('nope')
  })

  describe('revealHiddenChars', () => {
    it('leaves plain text unchanged', () => {
      expect(revealHiddenChars('ls -la /tmp 한글')).toEqual({ text: 'ls -la /tmp 한글', hasHidden: false })
    })

    it('shows bidi controls as visible tokens', () => {
      const result = revealHiddenChars('rm ‮foo')
      expect(result.text).toContain('⟨U+202E⟩')
      expect(result.hasHidden).toBe(true)
    })

    it('shows zero-width and control characters', () => {
      expect(revealHiddenChars('a​b').text).toBe('a⟨U+200B⟩b')
      expect(revealHiddenChars('a\u0007b\u0085c﻿').text).toBe('a⟨U+0007⟩b⟨U+0085⟩c⟨U+FEFF⟩')
    })

    it.each([
      ['soft hyphen', '\u00AD', '00AD'],
      ['Hangul filler', '\u3164', '3164'],
      ['halfwidth Hangul filler', '\uFFA0', 'FFA0'],
      ['Arabic letter mark', '\u061C', '061C'],
      ['line separator', '\u2028', '2028'],
      ['invisible times', '\u2062', '2062'],
      ['variation selector', '\uFE0F', 'FE0F'],
      ['no-break space', '\u00A0', '00A0'],
      ['en quad', '\u2000', '2000'],
      ['ideographic space', '\u3000', '3000'],
      ['braille blank', '\u2800', '2800'],
      ['tag character', '\u{E0041}', 'E0041']
    ])('shows a %s', (_label, char, code) => {
      expect(revealHiddenChars(`a${char}b`)).toEqual({ text: `a⟨U+${code}⟩b`, hasHidden: true })
    })

    it('leaves ordinary spaces, Korean, CJK and emoji bases alone', () => {
      const text = 'echo "한글 漢字 かな" && ls -la 😀'
      expect(revealHiddenChars(text)).toEqual({ text, hasHidden: false })
    })

    it('keeps newline and tab', () => {
      expect(revealHiddenChars('a\n\tb')).toEqual({ text: 'a\n\tb', hasHidden: false })
    })
  })

  describe('revealPath', () => {
    it('leaves an ordinary path alone, spaces inside included', () => {
      expect(revealPath('/srv/my app/배포 메모.txt')).toEqual({ text: '/srv/my app/배포 메모.txt', hasHidden: false })
    })

    it('shows a line break or a tab, which a path should not have', () => {
      expect(revealPath('/etc/hosts\n요청 경로: /tmp/a')).toEqual({ text: '/etc/hosts⟨U+000A⟩요청 경로: /tmp/a', hasHidden: true })
      expect(revealPath('/tmp/a\tb')).toEqual({ text: '/tmp/a⟨U+0009⟩b', hasHidden: true })
    })

    it('shows blanks at either end, which make it another file', () => {
      expect(revealPath('/etc/hosts ')).toEqual({ text: '/etc/hosts⟨U+0020⟩', hasHidden: true })
      expect(revealPath('  /etc/hosts')).toEqual({ text: '⟨U+0020⟩⟨U+0020⟩/etc/hosts', hasHidden: true })
    })

    it('shows hidden characters like any other text', () => {
      expect(revealPath('/tmp/\u202Etxt.exe')).toEqual({ text: '/tmp/⟨U+202E⟩txt.exe', hasHidden: true })
    })
  })
})
