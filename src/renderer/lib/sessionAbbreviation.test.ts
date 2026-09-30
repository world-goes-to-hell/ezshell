import { describe, it, expect } from 'vitest'
import { getAbbreviation } from './sessionAbbreviation'

describe('getAbbreviation', () => {
  it('drops a leading bracket tag and uses the last word', () => {
    expect(getAbbreviation('[개발] 바우처 WAS')).toBe('WAS')
    expect(getAbbreviation('[운영] MBRIS DB')).toBe('DB')
  })

  it('shortens latin words to three uppercase letters', () => {
    expect(getAbbreviation('[개발] 바우처 Sync')).toBe('SYN')
    expect(getAbbreviation('[개발] 생물다양성 newspecies')).toBe('NEW')
  })

  it('keeps trailing digits so numbered servers stay distinct', () => {
    expect(getAbbreviation('[개발] 생다 Swarm1')).toBe('SW1')
    expect(getAbbreviation('[개발] 생다 Swarm2')).toBe('SW2')
  })

  it('prefers the parenthesised qualifier', () => {
    expect(getAbbreviation('[운영] MBRIS WAS(gis)')).toBe('GIS')
    expect(getAbbreviation('[운영] MBRIS WAS(su)')).toBe('SU')
  })

  it('splits on hyphens and underscores', () => {
    expect(getAbbreviation('[개발] MBRIS-PORTAL')).toBe('POR')
    expect(getAbbreviation('db_master')).toBe('MAS')
  })

  it('joins a bare number with the word before it', () => {
    expect(getAbbreviation('dev-web-01')).toBe('W01')
    expect(getAbbreviation('web 2')).toBe('WE2')
  })

  it('takes the latin prefix of a mixed word', () => {
    expect(getAbbreviation('[개발] 생다 WEB서버')).toBe('WEB')
  })

  it('uses two characters for hangul words', () => {
    expect(getAbbreviation('[개발] 생다 도커')).toBe('도커')
    expect(getAbbreviation('[개발] 코아 개발서버')).toBe('개발')
    expect(getAbbreviation('개인용')).toBe('개인')
  })

  it('prefers the last latin word over a trailing hangul word', () => {
    expect(getAbbreviation('[개발] 생다 DB 도커')).toBe('DB')
    expect(getAbbreviation('[개발] 코아 MCP 개발서버')).toBe('MCP')
  })

  it('uses the host part of a user@host name', () => {
    expect(getAbbreviation('root@gateway')).toBe('GAT')
  })

  it('uses the last octet of an IPv4 address', () => {
    expect(getAbbreviation('192.168.0.15')).toBe('15')
    expect(getAbbreviation('admin@10.0.0.7')).toBe('7')
  })

  it('keeps a bracket tag when nothing else is left', () => {
    expect(getAbbreviation('[운영]')).toBe('운영')
  })

  it('returns a placeholder for empty input', () => {
    expect(getAbbreviation('')).toBe('?')
    expect(getAbbreviation('   ')).toBe('?')
  })
})
