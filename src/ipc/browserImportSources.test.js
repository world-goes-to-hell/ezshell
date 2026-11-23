import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createBrowserImportSources } from './browserImportSources.js'

let home, env, launch, sources

function file(name, contents = '') {
  fs.mkdirSync(path.dirname(name), { recursive: true })
  fs.writeFileSync(name, contents)
  return name
}

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'ezshell-browser-import-'))
  env = { LOCALAPPDATA: path.join(home, 'Local'), APPDATA: path.join(home, 'Roaming'), 'ProgramFiles(x86)': path.join(home, 'Program Files (x86)') }
  launch = vi.fn().mockResolvedValue(undefined)
  sources = createBrowserImportSources({ platform: 'win32', home, env, launch })
})
afterEach(() => fs.rmSync(home, { recursive: true, force: true }))

describe('browser import sources', () => {
  it('lists installed profiles using display names and opens the selected Chrome profile', async () => {
    const chrome = file(path.join(env.LOCALAPPDATA, 'Google', 'Chrome', 'Application', 'chrome.exe'))
    const root = path.join(env.LOCALAPPDATA, 'Google', 'Chrome', 'User Data')
    file(path.join(root, 'Local State'), JSON.stringify({
      os_crypt: { encrypted_key: 'marker-not-needed-for-import' },
      profile: { info_cache: {
        Default: { name: '개인' },
        'Profile 1': { name: '업무', user_name: 'email-not-needed@example.test' },
        'Profile 2': { name: '숨김', is_omitted: true },
        'Profile 3': { name: '삭제됨' },
        '../ignored': { name: '잘못된 경로' },
      } },
    }))
    for (const folder of ['Default', 'Profile 1', 'Profile 2', '../ignored']) fs.mkdirSync(path.join(root, folder))
    const result = await sources.list()
    expect(result).toEqual([{ id: 'chrome', name: 'Google Chrome', profiles: [
      { id: expect.any(String), name: '개인' },
      { id: expect.any(String), name: '업무' },
    ] }])
    expect(await sources.listDataSources()).toEqual(result)
    expect(launch).not.toHaveBeenCalled()
    const { id } = result[0].profiles[1]
    expect(await sources.dataDirectory(id)).toBe(path.join(root, 'Profile 1'))
    expect(await sources.dataDirectory(chrome)).toBeNull()
    expect(await sources.open(id)).toBe(true)
    expect(launch).toHaveBeenCalledWith(chrome, ['--profile-directory=Profile 1', '--ignore-profile-directory-if-not-exists', '--new-window', 'chrome://password-manager/settings'])
    fs.renameSync(path.join(root, 'Profile 1'), path.join(root, 'removed'))
    expect(await sources.open(id)).toBe(false)
    expect(await sources.open(chrome)).toBe(false)
    expect(launch).toHaveBeenCalledTimes(1)
  })

  it('falls back to standard Edge profile folders when metadata is unreadable', async () => {
    const edge = file(path.join(env['ProgramFiles(x86)'], 'Microsoft', 'Edge', 'Application', 'msedge.exe'))
    const root = path.join(env.LOCALAPPDATA, 'Microsoft', 'Edge', 'User Data')
    file(path.join(root, 'Local State'), 'not-json')
    for (const folder of ['Default', 'Profile 3', 'System Profile']) fs.mkdirSync(path.join(root, folder))
    const [browser] = await sources.list()
    expect(browser.name).toBe('Microsoft Edge')
    expect(browser.profiles.map(profile => profile.name)).toEqual(['Default', 'Profile 3'])
    expect(await sources.open(browser.profiles[0].id)).toBe(true)
    expect(await sources.listDataSources()).toEqual([browser])
    expect(launch).toHaveBeenCalledWith(edge, ['--profile-directory=Default', '--ignore-profile-directory-if-not-exists', '--new-window', 'edge://settings/autofill/passwords'])
  })

  it('discovers and opens an existing Firefox profile by its absolute path', async () => {
    const firefox = file(path.join(env['ProgramFiles(x86)'], 'Mozilla Firefox', 'firefox.exe'))
    const root = path.join(env.APPDATA, 'Mozilla', 'Firefox')
    const externalProfile = path.join(home, 'Firefox profiles', 'personal')
    file(path.join(root, 'profiles.ini'), [
      '[Install123]', 'Default=Profiles/missing',
      '[Profile0]', 'Name=Default Release', 'IsRelative=1', 'Path=Profiles/local.default-release',
      '[Profile1]', 'Name=개인', 'IsRelative=0', `Path=${externalProfile}`,
      '[Profile2]', 'Name=삭제됨', 'IsRelative=1', 'Path=Profiles/missing',
      '[Profile3]', 'Name=경로 오류', 'IsRelative=1', 'Path=../',
    ].join('\r\n'))
    fs.mkdirSync(path.join(root, 'Profiles', 'local.default-release'), { recursive: true })
    fs.mkdirSync(externalProfile, { recursive: true })
    const [browser] = await sources.list()
    expect(browser.name).toBe('Mozilla Firefox')
    expect(browser.profiles.map(profile => profile.name)).toEqual(['Default Release', '개인'])
    expect(await sources.listDataSources()).toEqual([])
    expect(await sources.open(browser.profiles[1].id)).toBe(true)
    expect(launch).toHaveBeenCalledWith(firefox, ['-profile', externalProfile, '-new-window', 'about:logins'])
  })

  it('returns an empty list when nothing is installed and handles a fresh installation', async () => {
    expect(await sources.list()).toEqual([])
    const chrome = file(path.join(env.LOCALAPPDATA, 'Google', 'Chrome', 'Application', 'chrome.exe'))
    const [browser] = await sources.list()
    expect(browser.profiles).toEqual([{ id: expect.any(String), name: '기본 프로필' }])
    expect(await sources.listDataSources()).toEqual([])
    expect(await sources.open(browser.profiles[0].id)).toBe(true)
    expect(launch).toHaveBeenCalledWith(chrome, ['--new-window', 'chrome://password-manager/settings'])
  })
})
