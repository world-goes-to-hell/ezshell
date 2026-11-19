import { describe, expect, it } from 'vitest'
import type { AgentHistorySession } from '../types'
import { filterSessions, folderName, isInside, relativeTime, resumeCommand, withContentMatches } from './agentHistory'

const ID = '01a1ec18-9b8a-71c1-839d-2e31c010300f'

const session = (over: Partial<AgentHistorySession>): AgentHistorySession => ({
  key: `claude:${ID}`, agent: 'claude', id: ID, cwd: 'D:\\work\\app', branch: 'main', model: 'claude-opus-5-5',
  version: null, title: '로그 화면', preview: '실시간 보기 개선', hasPrompt: true, created: null, updated: 0, ...over
})

describe('isInside', () => {
  it('compares Windows paths without case and with either slash', () => {
    expect(isInside('d:/WORK/app/sub', ['D:\\work\\app'])).toBe(true)
    expect(isInside('D:\\work\\application', ['D:\\work\\app'])).toBe(false)
    expect(isInside('D:\\work\\app', ['D:\\work\\app\\'])).toBe(true)
  })

  it('keeps case on other systems', () => {
    expect(isInside('/home/me/App', ['/home/me/app'])).toBe(false)
    expect(isInside('/home/me/app/x', ['/home/me/app'])).toBe(true)
    expect(isInside(null, ['/'])).toBe(false)
  })
})

describe('filterSessions', () => {
  const list = [
    session({ key: 'a', title: '로그 화면', cwd: 'D:\\work\\app' }),
    session({ key: 'b', title: '사이드바', cwd: 'D:\\work\\app-feature', agent: 'codex', branch: 'feat/side' }),
    session({ key: 'c', title: '', preview: '', hasPrompt: false, cwd: 'D:\\work\\app' })
  ]
  const keys = (filter: Parameters<typeof filterSessions>[1]) => filterSessions(list, filter).map(s => s.key)

  it('hides sessions without a prompt unless asked', () => {
    expect(keys({ query: '', roots: null, showEmpty: false })).toEqual(['a', 'b'])
    expect(keys({ query: '', roots: null, showEmpty: true })).toEqual(['a', 'b', 'c'])
  })

  it('limits to the project folders', () => {
    expect(keys({ query: '', roots: ['D:\\work\\app'], showEmpty: false })).toEqual(['a'])
    expect(keys({ query: '', roots: ['D:\\work\\app', 'D:\\work\\app-feature'], showEmpty: false })).toEqual(['a', 'b'])
  })

  it('needs every word, in any field', () => {
    expect(keys({ query: 'codex side', roots: null, showEmpty: false })).toEqual(['b'])
    expect(keys({ query: 'APP 로그', roots: null, showEmpty: false })).toEqual(['a'])
    expect(keys({ query: '없는말', roots: null, showEmpty: false })).toEqual([])
  })
})

describe('withContentMatches', () => {
  const list = [
    session({ key: 'a', title: '로그 화면', cwd: 'D:\\work\\app' }),
    session({ key: 'b', title: '사이드바', cwd: 'D:\\work\\other' }),
    session({ key: 'c', title: '', preview: '', hasPrompt: false, cwd: 'D:\\work\\app' }),
    session({ key: 'd', title: '패널', cwd: 'D:\\work\\app' })
  ]
  const keys = (filter: Parameters<typeof filterSessions>[1], hits: [string, string][]) => withContentMatches(list, filter, new Map(hits)).map(s => s.key)

  it('adds sessions whose conversation matched to those matching by fields, in list order', () => {
    expect(keys({ query: '로그', roots: null, showEmpty: false }, [['d', '…로그…']])).toEqual(['a', 'd'])
  })

  it('keeps the folder scope and the empty-session switch for content matches too', () => {
    expect(keys({ query: '없는말', roots: ['D:\\work\\app'], showEmpty: false }, [['b', 'x'], ['c', 'x'], ['d', 'x']])).toEqual(['d'])
    expect(keys({ query: '없는말', roots: null, showEmpty: true }, [['c', 'x']])).toEqual(['c'])
  })

  it('is the field search alone without content matches', () => {
    expect(keys({ query: '사이드', roots: null, showEmpty: false }, [])).toEqual(['b'])
  })
})

describe('relativeTime', () => {
  const now = new Date(2026, 10, 19, 12, 0, 0).getTime()
  it('counts minutes, hours and days, then shows the date', () => {
    expect(relativeTime(now - 30_000, now)).toBe('방금')
    expect(relativeTime(now - 5 * 60_000, now)).toBe('5분 전')
    expect(relativeTime(now - 3 * 3600_000, now)).toBe('3시간 전')
    expect(relativeTime(now - 2 * 86400_000, now)).toBe('2일 전')
    expect(relativeTime(new Date(2026, 9, 1, 9).getTime(), now)).toBe('2026-10-01')
  })
})

describe('resumeCommand', () => {
  it('goes to the folder first, quoting it for the shell', () => {
    expect(resumeCommand({ agent: 'claude', id: ID, cwd: "D:\\it's" }, true)).toBe(`Set-Location -LiteralPath 'D:\\it''s'; claude --resume ${ID}`)
    expect(resumeCommand({ agent: 'codex', id: ID, cwd: "/home/it's" }, false)).toBe(`cd '/home/it'\\''s' && codex resume ${ID}`)
  })

  it('gives nothing for a missing folder, a bad id or a folder with a line break', () => {
    expect(resumeCommand({ agent: 'claude', id: ID, cwd: null }, true)).toBeNull()
    expect(resumeCommand({ agent: 'claude', id: 'x; rm -rf /', cwd: '/a' }, false)).toBeNull()
    expect(resumeCommand({ agent: 'claude', id: ID, cwd: '/a\nrm -rf /' }, false)).toBeNull()
  })
})

describe('folderName', () => {
  it('takes the last part', () => {
    expect(folderName('D:\\work\\app\\')).toBe('app')
    expect(folderName('/home/me/x')).toBe('x')
    expect(folderName(null)).toBe('')
  })
})
