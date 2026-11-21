import { describe, it, expect } from 'vitest'
import {
  collectUiSettings, parseUiSettingsFile, groupsOf, UI_SETTING_ENTRIES, UI_SETTINGS_FORMAT, UI_SETTINGS_MAX_BYTES
} from './uiSettingsBackup'

const context = { shortcutIds: ['newConnection', 'closeTab'] }
const now = new Date('2026-11-17T06:00:00Z')
const storage = (values: Record<string, string>) => (key: string) => (key in values ? values[key] : null)
const file = (settings: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
  JSON.stringify({ format: UI_SETTINGS_FORMAT, version: 1, exportedAt: now.toISOString(), settings, ...extra })

describe('collectUiSettings', () => {
  it('takes only listed keys', () => {
    const result = collectUiSettings(storage({
      terminalLogHighlight: 'off',
      'ssh-connection-history': '[{"host":"10.0.0.1"}]',
      recentCommands: '["rm -rf /"]',
      'dbTreeFilter:mysql:10.0.0.1:3306:root': '{}',
      terminalFindPrefs: '{"customDir":"/data/secret"}'
    }), context, now)
    expect(result.settings).toEqual({ terminalLogHighlight: 'off' })
    expect(result.format).toBe(UI_SETTINGS_FORMAT)
    expect(result.exportedAt).toBe('2026-11-17T06:00:00.000Z')
  })

  it('rewrites values through their readers and skips unusable ones', () => {
    const result = collectUiSettings(storage({
      fileExplorerWidth: '99999',
      dbTreeWidth: 'wide',
      containerPanelPrefs: '{"showAll":true,"autoRefresh":"yes","extra":"/home/me"}',
      customShortcuts: '{"closeTab":["Ctrl","Q"],"unknownAction":["Ctrl","X"]}',
      'ui-store': '{"state":{"sidebarMode":"compact","zenMode":true,"appZoom":1.25,"browserTabMaxWidth":437},"version":0}'
    }), context, now)
    expect(result.settings.fileExplorerWidth).toBe('800')
    expect(result.settings.dbTreeWidth).toBeUndefined()
    expect(JSON.parse(result.settings.containerPanelPrefs)).toEqual({ showAll: true, autoRefresh: false })
    expect(Object.keys(JSON.parse(result.settings.customShortcuts))).toEqual(['closeTab'])
    expect(JSON.parse(result.settings['ui-store']).state).toEqual({ sidebarMode: 'compact', appZoom: 1.25, browserTabMaxWidth: 440 })
  })

  it('keeps a known theme choice and drops broken custom themes', () => {
    const result = collectUiSettings(storage({
      'theme-store': JSON.stringify({ state: { currentThemeId: 'macos-dark', customThemes: ['junk', { id: 'x' }], surface: 'glass', windowOpacity: 0.1 } })
    }), context, now)
    const state = JSON.parse(result.settings['theme-store']).state
    expect(state.currentThemeId).toBe('macos-dark')
    expect(state.customThemes).toEqual([])
    expect(state.surface).toBe('glass')
    expect(state.windowOpacity).toBe(0.5)
  })

  it('leaves out a theme id nobody knows', () => {
    const result = collectUiSettings(storage({ 'theme-store': '{"state":{"currentThemeId":"custom-gone"}}' }), context, now)
    expect(JSON.parse(result.settings['theme-store']).state.currentThemeId).toBeUndefined()
  })
})

describe('parseUiSettingsFile', () => {
  it('reads back what collect wrote', () => {
    const exported = collectUiSettings(storage({ terminalFileZone: 'off', sftpTransferQueueHeight: '240' }), context, now)
    const result = parseUiSettingsFile(JSON.stringify(exported), context)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.import.values.map(item => [item.entry.key, item.value])).toEqual([['sftpTransferQueueHeight', '240'], ['terminalFileZone', 'off']])
    expect(result.import.invalid).toBe(0)
    expect(result.import.unknown).toBe(0)
  })

  it('never applies keys that are not on the list', () => {
    const result = parseUiSettingsFile(file({
      terminalLogHighlight: 'on',
      'ssh-connection-history': '[]',
      sessions: '[{"host":"evil"}]',
      __proto__: 'x'
    }), context)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.import.values.map(item => item.entry.key)).toEqual(['terminalLogHighlight'])
    expect(result.import.unknown).toBeGreaterThanOrEqual(2)
  })

  it('counts listed keys with unusable values', () => {
    const result = parseUiSettingsFile(file({ terminalLogHighlight: 'maybe', dbTreeWidth: 300, fileExplorerWidth: '300' }), context)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.import.values.map(item => item.entry.key)).toEqual(['fileExplorerWidth'])
    expect(result.import.invalid).toBe(2)
  })

  it('rejects other files', () => {
    expect(parseUiSettingsFile('not json', context).ok).toBe(false)
    expect(parseUiSettingsFile('[]', context).ok).toBe(false)
    expect(parseUiSettingsFile(JSON.stringify({ sessions: [], version: '1.0' }), context).ok).toBe(false)
    expect(parseUiSettingsFile(file({}), context).ok).toBe(false)
    expect(parseUiSettingsFile(file({ terminalLogHighlight: 'off' }, { version: 2 }), context).ok).toBe(false)
    expect(parseUiSettingsFile(file({ terminalLogHighlight: 'off' }, { settings: ['x'] }), context).ok).toBe(false)
    expect(parseUiSettingsFile(' '.repeat(UI_SETTINGS_MAX_BYTES + 1), context).ok).toBe(false)
  })

  it('normalizes imported values the same way as stored ones', () => {
    const result = parseUiSettingsFile(file({
      'theme-store': JSON.stringify({ state: { currentThemeId: 'no-such-theme', surface: 'liquid', windowOpacity: 7 } }),
      customShortcuts: '{"closeTab":["Ctrl","Q"],"bad":"x"}'
    }), context)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    const theme = JSON.parse(result.import.values[0].value).state
    expect(theme).toEqual({ customThemes: [], surface: 'flat', windowOpacity: 1 })
    expect(Object.keys(JSON.parse(result.import.values[1].value))).toEqual(['closeTab'])
  })
})

describe('entries', () => {
  it('have unique keys, none of which can carry a host or an account', () => {
    const keys = UI_SETTING_ENTRIES.map(entry => entry.key)
    expect(new Set(keys).size).toBe(keys.length)
    for (const key of keys) expect(key).not.toMatch(/history|stats|recent|snippet|session|dbTreeFilter|dbConsoles|dbDefaultSchema|Find/i)
  })

  it('groupsOf lists groups in display order', () => {
    const pick = (key: string) => ({ entry: UI_SETTING_ENTRIES.find(entry => entry.key === key)!, value: '' })
    expect(groupsOf([pick('terminalLogHighlight'), pick('theme-store')])).toEqual(['테마', '보기 옵션'])
  })
})
