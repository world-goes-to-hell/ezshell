import { describe, expect, it } from 'vitest'
import { DEFAULT_WORKSPACE_PREFS, clampWorkspaceWidth, parseWorkspacePrefs } from './workspacePanel'

describe('parseWorkspacePrefs', () => {
  it('reads what was stored and falls back for anything else', () => {
    expect(parseWorkspacePrefs(JSON.stringify({ isOpen: true, width: 500 }))).toEqual({ isOpen: true, width: 500 })
    expect(parseWorkspacePrefs(JSON.stringify({ isOpen: 'yes', width: 9999 }))).toEqual({ isOpen: false, width: 720 })
    expect(parseWorkspacePrefs('broken')).toEqual(DEFAULT_WORKSPACE_PREFS)
    expect(parseWorkspacePrefs(null)).toEqual(DEFAULT_WORKSPACE_PREFS)
  })
})

describe('clampWorkspaceWidth', () => {
  it('stays within its limits and at most half the window', () => {
    expect(clampWorkspaceWidth(100, 1600)).toBe(280)
    expect(clampWorkspaceWidth(900, 1600)).toBe(720)
    expect(clampWorkspaceWidth(600, 1000)).toBe(500)
    expect(clampWorkspaceWidth(400, 400)).toBe(280)
    expect(clampWorkspaceWidth(Number.NaN, 1600)).toBe(380)
  })
})
