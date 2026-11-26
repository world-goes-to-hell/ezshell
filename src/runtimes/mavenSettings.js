const fs = require('node:fs')
const path = require('node:path')
const { randomUUID } = require('node:crypto')
const { fileURLToPath, pathToFileURL } = require('node:url')
const { isLocalFilePath } = require('../localKeyPath.js')

const REPOSITORY_ID = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/
const PRESET_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const HTTP_BLOCKER = [
  '    <mirror>',
  '      <id>maven-default-http-blocker</id>',
  '      <mirrorOf>external:http:*</mirrorOf>',
  '      <url>http://0.0.0.0/</url>',
  '      <blocked>true</blocked>',
  '    </mirror>'
].join('\n')
const XML_ENTITIES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }
const xml = text => text.replace(/[&<>"']/g, ch => XML_ENTITIES[ch])

function projectMirrorId(repositoryId) {
  return typeof repositoryId === 'string' && REPOSITORY_ID.test(repositoryId) ? `ezshell-${repositoryId}` : null
}

function includesHttpBlocker(mavenVersion) {
  const version = typeof mavenVersion === 'string' && /^(\d+)\.(\d+)\.(\d+)(?:[-+][A-Za-z0-9.-]+)?$/.exec(mavenVersion)
  if (!version) return true
  const [major, minor, patch] = version.slice(1).map(Number)
  return major > 3 || (major === 3 && (minor > 8 || (minor === 8 && patch >= 1)))
}

function repositoryUrl(value) {
  if (typeof value !== 'string' || /[\u0000-\u0020\u007f\\]/.test(value) || !/^(?:https:\/\/[^/]|file:\/\/\/(?!\/))/i.test(value)
    || /[?#]/.test(value)) throw new Error('저장소에는 HTTPS 주소나 이 PC의 file:/// 주소를 입력해 주세요.')
  let url
  try {
    url = new URL(value)
    if (url.protocol === 'https:' && url.hostname && !url.username && !url.password) {
      // An empty user-info field also has no place in a repository URL.
      if (!value.slice('https://'.length).split('/')[0].includes('@')) return url.href
    }
    if (url.protocol === 'file:' && !url.hostname) {
      const local = fileURLToPath(url)
      if (isLocalFilePath(local)) return pathToFileURL(local).href
    }
  } catch { /* Report one validation error for invalid URLs. */ }
  throw new Error('저장소 주소를 확인해 주세요. 자격 증명이나 네트워크 파일 경로는 사용할 수 없습니다.')
}

/**
 * Each approved mirror applies to one repository ID. An exact match takes precedence over Maven's
 * default HTTP blocker. The replacement uses HTTPS or a local file repository.
 */
function normalizeMavenMirrors(mirrors = []) {
  if (!Array.isArray(mirrors)) throw new Error('Maven 저장소 대체 목록을 확인해 주세요.')
  const seen = new Set()
  return mirrors.map(mirror => {
    const id = mirror?.repositoryId
    if (!projectMirrorId(id) || seen.has(id)) {
      throw new Error('중복 없이 정확한 Maven 저장소 ID를 입력해 주세요.')
    }
    seen.add(id)
    return { repositoryId: id, url: repositoryUrl(mirror.url) }
  })
}

function renderMavenSettings({ mirrors, mavenVersion } = {}) {
  const entries = normalizeMavenMirrors(mirrors).map(({ repositoryId, url }) => [
    '    <mirror>',
    `      <id>${xml(projectMirrorId(repositoryId))}</id>`,
    `      <mirrorOf>${xml(repositoryId)}</mirrorOf>`,
    `      <url>${xml(url)}</url>`,
    '    </mirror>'
  ].join('\n'))
  const blocked = includesHttpBlocker(mavenVersion)
  const schema = blocked ? '1.2.0' : '1.0.0'
  if (blocked) entries.push(HTTP_BLOCKER)
  return ['<?xml version="1.0" encoding="UTF-8"?>',
    `<settings xmlns="http://maven.apache.org/SETTINGS/${schema}">`,
    '  <mirrors>', ...entries, '  </mirrors>', '</settings>', ''].join('\n')
}

function mavenSettingsFile(userData, presetId, create) {
  if (typeof presetId !== 'string' || !PRESET_ID.test(presetId)) {
    throw new Error('Maven 설정의 실행 구성 ID를 확인해 주세요.')
  }
  if (!isLocalFilePath(userData)) throw new Error('앱의 Maven 설정 폴더를 확인할 수 없습니다.')
  let directory = fs.realpathSync(userData)
  if (!isLocalFilePath(directory)) throw new Error('앱의 Maven 설정 폴더를 확인할 수 없습니다.')
  for (const segment of ['runtimes', 'maven-settings']) {
    directory = path.join(directory, segment)
    if (create) {
      try { fs.mkdirSync(directory) } catch (error) { if (error.code !== 'EEXIST') throw error }
    }
    const stat = fs.lstatSync(directory, { throwIfNoEntry: false })
    if (!stat && !create) return null
    if (!stat?.isDirectory()) throw new Error('앱의 Maven 설정 폴더를 확인할 수 없습니다.')
  }
  const target = path.join(directory, `${presetId}.xml`)
  const current = fs.lstatSync(target, { throwIfNoEntry: false })
  if (current && !current.isFile()) throw new Error('앱의 Maven 설정 파일을 확인할 수 없습니다.')
  return target
}

/** Returns the absolute Maven settings filename. Pass the selected Maven version for its HTTP policy. */
function writeMavenSettings({ userData, presetId, mirrors, mavenVersion } = {}) {
  const contents = renderMavenSettings({ mirrors, mavenVersion })
  const target = mavenSettingsFile(userData, presetId, true)
  const directory = path.dirname(target)
  const temporary = path.join(directory, `.${randomUUID()}.tmp`)
  const fd = fs.openSync(temporary, 'wx', 0o600)
  try {
    try { fs.writeFileSync(fd, contents, 'utf8') } finally { fs.closeSync(fd) }
    fs.renameSync(temporary, target)
    return target
  } finally {
    fs.rmSync(temporary, { force: true })
  }
}

function removeLaunchSettings(directory, name) {
  const stat = fs.lstatSync(directory, { throwIfNoEntry: false })
  if (!stat?.isDirectory()) return
  fs.rmSync(path.join(directory, name), { force: true })
  try { fs.rmdirSync(directory) } catch (error) { if (error.code !== 'ENOENT' && error.code !== 'ENOTEMPTY') throw error }
}

/** Keep each subprocess's settings stable when the same preset runs in another worktree. */
function stageMavenSettings(options) {
  const saved = writeMavenSettings(options)
  const name = path.basename(saved)
  const directory = fs.mkdtempSync(path.join(path.dirname(saved), `.run-${options.presetId}-`))
  const file = path.join(directory, name)
  const cleanup = () => removeLaunchSettings(directory, name)
  try {
    fs.copyFileSync(saved, file, fs.constants.COPYFILE_EXCL)
    return { file, cleanup }
  } catch (error) {
    cleanup()
    throw error
  }
}

function removeMavenSettings({ userData, presetId }) {
  const target = mavenSettingsFile(userData, presetId, false)
  if (!target) return
  fs.rmSync(target, { force: true })
  const root = path.dirname(target)
  const prefix = `.run-${presetId}-`
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (entry.isDirectory() && entry.name.startsWith(prefix) && /^[A-Za-z0-9]{6}$/.test(entry.name.slice(prefix.length))) {
      removeLaunchSettings(path.join(root, entry.name), path.basename(target))
    }
  }
}

module.exports = { renderMavenSettings, writeMavenSettings, stageMavenSettings, removeMavenSettings, normalizeMavenMirrors, projectMirrorId }
