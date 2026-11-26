import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createDevelopmentErrors } from './developmentErrors.js'
import { appendMavenSettings, diagnosisContext, mavenApproval, prepareMavenSettings, presetSuggestions, suggestedMavenFields,
  wrapperMavenVersion } from './runSuggestions.js'
import { removeMavenSettings } from '../runtimes/mavenSettings.js'

const preset = { id: 'e54f0cc1-af24-47d3-b5bf-cdef88739920', kind: 'task', relative: '.', taskId: '.:maven' }
const mirror = { repositoryId: 'legacy', url: 'https://repo.example.test/maven/' }
const blocked = '[ERROR] Could not transfer artifact example:sample:jar:1 from/to maven-default-http-blocker (http://0.0.0.0/): Blocked mirror for repositories: [legacy (http://legacy.invalid/repo/, default, releases+snapshots)]'
let root
beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'ezshell-run-suggestions-')) })
afterEach(() => { fs.rmSync(root, { recursive: true, force: true }) })

function runWith(line, mirrors) {
  const logs = createDevelopmentErrors()
  logs.feed(line + '\n', false)
  return { logs, diagnosis: diagnosisContext({ ...preset, mavenMirrors: mirrors }) }
}

describe('Maven run suggestions', () => {
  it('applies the exact repository in the current diagnosis, ignoring fields claimed by the caller', () => {
    const run = runWith(blocked)
    const [suggestion] = presetSuggestions(preset, run)
    expect(suggestion).toMatchObject({ kind: 'mavenHttpBlocked', repositoryId: 'legacy', apply: 'mavenMirror' })
    expect(suggestedMavenFields(preset, run, { id: suggestion.id, repositoryId: 'forged', replacementUrl: mirror.url })).toEqual({
      mavenMirrors: [mirror]
    })
    expect(() => suggestedMavenFields(preset, runWith(blocked), { id: suggestion.id, replacementUrl: mirror.url })).toThrow(/최근 실행/)
    expect(() => suggestedMavenFields(preset, run, { id: suggestion.id, replacementUrl: 'http://repo.example.test/' })).toThrow(/HTTPS/)
    expect(presetSuggestions({ ...preset, taskId: '.:node' }, run)[0]).not.toHaveProperty('apply')
    expect(presetSuggestions({ ...preset, relative: 'another' }, run)[0]).not.toHaveProperty('apply')
  })

  it('requires a current effective user mirror to opt out of user settings', () => {
    const configured = { ...preset, mavenMirrors: [mirror] }
    const run = runWith('[DEBUG] Using mirror settings-from-user (https://other.example.test/maven) for legacy (http://legacy.invalid/repo/).', [mirror])
    const [suggestion] = presetSuggestions(configured, run)
    expect(suggestion).toMatchObject({ kind: 'mavenUserMirror', apply: 'mavenUserSettings', requiresApproval: true })
    expect(suggestedMavenFields(configured, run, { id: suggestion.id })).toEqual({ mavenMirrors: [mirror], mavenUserSettings: false })
    const active = { ...configured, mavenUserSettings: false }
    expect(() => suggestedMavenFields(active, run, { id: suggestion.id })).toThrow(/최근 실행/)
    expect(mavenApproval(active).text).toMatch(/서버 인증·프록시·미러·로컬 저장소/)
  })

  it('uses isolated global or user settings, and cleans only the matching preset file', () => {
    const configured = { ...preset, mavenMirrors: [mirror] }
    expect(prepareMavenSettings(preset, { userData: root })).toEqual({ args: [] })
    const { args, cleanup } = prepareMavenSettings(configured, { userData: root, mavenVersion: '3.6.3' })
    const library = path.join(fs.realpathSync(root), 'runtimes', 'maven-settings')
    expect(args[0]).toBe('-gs')
    expect(path.dirname(path.dirname(args[1]))).toBe(library)
    expect(path.basename(args[1])).toBe(`${preset.id}.xml`)
    expect(fs.readFileSync(args[1], 'utf8')).toContain('<mirrorOf>legacy</mirrorOf>')
    expect(fs.readFileSync(args[1], 'utf8')).not.toContain('<blocked>')
    const newer = prepareMavenSettings({ ...configured, mavenUserSettings: false }, { userData: root })
    expect(newer.args[0]).toBe('-s')
    expect(fs.readFileSync(newer.args[1], 'utf8')).toContain('<blocked>')
    expect(fs.readFileSync(args[1], 'utf8')).not.toContain('<blocked>')
    cleanup()
    expect(fs.existsSync(newer.args[1])).toBe(true)
    removeMavenSettings({ userData: root, presetId: preset.id })
    removeMavenSettings({ userData: root, presetId: preset.id })
    expect(fs.readdirSync(library)).toEqual([])
  })

  it('passes a settings path containing spaces and quotes as one argument to each shell', () => {
    expect(appendMavenSettings('.\\mvnw.cmd spring-boot:run', ['-gs', "C:\\Jane's workspace\\settings.xml"], 'win32'))
      .toBe(".\\mvnw.cmd spring-boot:run -gs '\"C:\\Jane''s workspace\\settings.xml\"'")
    expect(appendMavenSettings('./mvnw spring-boot:run', ['-s', "/Jane's workspace/settings.xml"], 'linux'))
      .toBe("./mvnw spring-boot:run -s '/Jane'\\''s workspace/settings.xml'")
    expect(() => appendMavenSettings('mvn verify', ['-gs', 'C:\\test\\%TEMP%\\settings.xml'], 'win32')).toThrow('%')
  })

  it.skipIf(process.platform !== 'win32')('passes literal settings and Maven properties through PowerShell to the batch launcher', () => {
    const bat = path.join(root, 'mvn.cmd')
    fs.writeFileSync(bat, `@echo off\r\n"${process.execPath}" -e "console.log(JSON.stringify(process.argv.slice(1)))" -- %*\r\n`)
    const filename = path.join(root, 'R&D', 'settings.xml')
    const javac = `-Dmaven.compiler.executable=${path.join(root, "Jane's R&D JDK", 'bin', 'javac.exe')}`
    const launcher = `& '${bat.replaceAll("'", "''")}' verify`
    const args = [javac, '-s', filename, '-gs', path.join(root, 'empty.xml')]
    const command = appendMavenSettings(launcher, args, 'win32')
    const encoded = Buffer.from(command, 'utf16le').toString('base64')
    const stdout = execFileSync('powershell.exe', ['-NoProfile', '-EncodedCommand', encoded], { encoding: 'utf8', windowsHide: true })
    expect(JSON.parse(stdout)).toEqual(['verify', ...args])
  })

  it('reads the version of the selected wrapper from local bounded metadata', () => {
    const folder = path.join(root, '.mvn', 'wrapper')
    fs.mkdirSync(folder, { recursive: true })
    fs.writeFileSync(path.join(folder, 'maven-wrapper.properties'), 'distributionUrl=https\\://repo.maven.apache.org/maven2/apache-maven-3.6.3-bin.zip\n')
    expect(wrapperMavenVersion({ cwd: root, command: '.\\mvnw.cmd spring-boot:run' })).toBe('3.6.3')
    expect(wrapperMavenVersion({ cwd: root, command: 'mvn spring-boot:run' })).toBeUndefined()
  })
})
