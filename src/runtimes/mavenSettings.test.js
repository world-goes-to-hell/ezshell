import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { renderMavenSettings, writeMavenSettings } from './mavenSettings.js'

const presetId = 'e54f0cc1-af24-47d3-b5bf-cdef88739920'
let root

beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'ezshell-maven-settings-')) })
afterEach(() => { fs.rmSync(root, { recursive: true, force: true }) })

describe('project Maven settings', () => {
  it('renders exact repository mirrors with XML escaping and no credentials', () => {
    const local = pathToFileURL(path.join(root, 'local repo & releases')).href
    const settings = renderMavenSettings({ mirrors: [
      { repositoryId: 'legacy-releases', url: "https://packages.example.test/maven/release&team's/" },
      { repositoryId: 'old.repo', url: local }
    ] })
    expect(settings).toContain('<id>ezshell-legacy-releases</id>')
    expect(settings).toContain('<mirrorOf>legacy-releases</mirrorOf>')
    expect(settings).toContain('<url>https://packages.example.test/maven/release&amp;team&apos;s/</url>')
    expect(settings).toContain('<mirrorOf>old.repo</mirrorOf>')
    expect(settings).toContain(`<url>${local.replaceAll('&', '&amp;')}</url>`)
    expect(settings).toMatch(/<id>maven-default-http-blocker<\/id>\s+<mirrorOf>external:http:\*<\/mirrorOf>\s+<url>http:\/\/0\.0\.0\.0\/<\/url>\s+<blocked>true<\/blocked>/)
    expect(settings).not.toMatch(/<(?:password|username|server|profiles)\b/)
  })

  it.each(['*', 'central,legacy', '!central', 'external:http:*', '../legacy', 'legacy<id>'])(
    'rejects a repository selector or malformed ID %s', repositoryId => {
      expect(() => renderMavenSettings({ mirrors: [{ repositoryId, url: 'https://packages.example.test/maven' }] }))
        .toThrow(/저장소 ID/)
    }
  )

  it.each([
    'http://packages.example.test/maven',
    'https://user:password@packages.example.test/maven',
    'https://@packages.example.test/maven',
    'https://packages.example.test/maven?token=opaque',
    'https://packages.example.test/maven#fragment',
    'https:////packages.example.test/maven',
    'file://server/share/repo',
    'file:////server/share/repo',
    'file://localhost/share/repo',
    'https://packages.example.test\\maven',
    'https://packages.example.test/maven\n'
  ])('rejects a non-local, ambiguous, insecure or credential-bearing URL', url => {
    expect(() => renderMavenSettings({ mirrors: [{ repositoryId: 'legacy', url }] })).toThrow(/저장소/)
  })

  it('rejects duplicate IDs before writing any file', () => {
    const entry = { repositoryId: 'central', url: 'https://packages.example.test/maven' }
    expect(() => writeMavenSettings({ userData: root, presetId, mirrors: [entry, entry] })).toThrow(/중복/)
    expect(fs.readdirSync(root)).toEqual([])
  })

  it.each([
    ['3.6.3', false],
    ['3.8.0', false],
    ['3.8.1', true],
    ['3.9.16', true],
    [undefined, true]
  ])('preserves the expected default HTTP policy for Maven %s', (mavenVersion, blocked) => {
    const mirrors = [{ repositoryId: 'legacy', url: 'https://packages.example.test/maven' }]
    const filename = writeMavenSettings({ userData: root, presetId, mirrors, mavenVersion })
    const settings = fs.readFileSync(filename, 'utf8')
    expect(settings).toContain('<mirrorOf>legacy</mirrorOf>')
    expect(settings.includes('<blocked>true</blocked>')).toBe(blocked)
    expect(settings).toContain(`http://maven.apache.org/SETTINGS/${blocked ? '1.2.0' : '1.0.0'}`)
  })

  it('writes and replaces only the approved preset file in the app profile', () => {
    const userSettings = path.join(root, '.m2', 'settings.xml')
    fs.mkdirSync(path.dirname(userSettings))
    fs.writeFileSync(userSettings, 'existing user settings')
    const filename = writeMavenSettings({ userData: root, presetId })
    const mirror = { repositoryId: 'legacy', url: 'https://packages.example.test/maven' }
    expect(filename).toBe(path.join(fs.realpathSync(root), 'runtimes', 'maven-settings', `${presetId}.xml`))
    expect(writeMavenSettings({ userData: root, presetId, mirrors: [mirror] })).toBe(filename)
    expect(fs.readFileSync(filename, 'utf8')).toBe(renderMavenSettings({ mirrors: [mirror] }))
    expect(fs.readFileSync(userSettings, 'utf8')).toBe('existing user settings')
    expect(fs.readdirSync(path.dirname(filename))).toEqual([`${presetId}.xml`])
    if (process.platform !== 'win32') expect(fs.statSync(filename).mode & 0o077).toBe(0)
  })

  it('rejects a path-like preset ID or a junction out of the profile', () => {
    expect(() => writeMavenSettings({ userData: root, presetId: '../outside' })).toThrow(/구성 ID/)
    const outside = path.join(root, 'outside')
    fs.mkdirSync(outside)
    fs.symlinkSync(outside, path.join(root, 'runtimes'), process.platform === 'win32' ? 'junction' : 'dir')
    expect(() => writeMavenSettings({ userData: root, presetId })).toThrow(/설정 폴더/)
    expect(fs.readdirSync(outside)).toEqual([])
  })
})
