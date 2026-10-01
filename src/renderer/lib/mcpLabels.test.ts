import { describe, it, expect } from 'vitest'
import { ALERT_LEVEL_OPTIONS, OUTCOME_LABELS, RISK_LABELS, formatAuditTime, maskToken, maskRegisterCommand, parsePort, revealHiddenChars, secondsLeft } from './mcpLabels'

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

    it('keeps newline and tab', () => {
      expect(revealHiddenChars('a\n\tb')).toEqual({ text: 'a\n\tb', hasHidden: false })
    })
  })
})
