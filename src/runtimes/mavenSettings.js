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
function renderMavenSettings({ mirrors = [], mavenVersion } = {}) {
  if (!Array.isArray(mirrors)) throw new Error('Maven 저장소 대체 목록을 확인해 주세요.')
  const seen = new Set()
  const entries = mirrors.map(mirror => {
    const id = mirror?.repositoryId
    const mirrorId = projectMirrorId(id)
    if (!mirrorId || seen.has(id)) {
      throw new Error('중복 없이 정확한 Maven 저장소 ID를 입력해 주세요.')
    }
    seen.add(id)
    const url = repositoryUrl(mirror.url)
    return [
      '    <mirror>',
      `      <id>${xml(mirrorId)}</id>`,
      `      <mirrorOf>${xml(id)}</mirrorOf>`,
      `      <url>${xml(url)}</url>`,
      '    </mirror>'
    ].join('\n')
  })
  const blocked = includesHttpBlocker(mavenVersion)
  const schema = blocked ? '1.2.0' : '1.0.0'
  if (blocked) entries.push(HTTP_BLOCKER)
  return ['<?xml version="1.0" encoding="UTF-8"?>',
    `<settings xmlns="http://maven.apache.org/SETTINGS/${schema}">`,
    '  <mirrors>', ...entries, '  </mirrors>', '</settings>', ''].join('\n')
}

/**
 * Returns the absolute filename to pass after -gs. Maven keeps using its usual user settings.
 * Pass the selected Maven version to match that release's default HTTP blocker.
 */
function writeMavenSettings({ userData, presetId, mirrors, mavenVersion } = {}) {
  if (typeof presetId !== 'string' || !PRESET_ID.test(presetId)) {
    throw new Error('Maven 설정의 실행 구성 ID를 확인해 주세요.')
  }
  const contents = renderMavenSettings({ mirrors, mavenVersion })
  if (!isLocalFilePath(userData)) throw new Error('앱의 Maven 설정 폴더를 확인할 수 없습니다.')
  let directory = fs.realpathSync(userData)
  if (!isLocalFilePath(directory)) throw new Error('앱의 Maven 설정 폴더를 확인할 수 없습니다.')
  for (const segment of ['runtimes', 'maven-settings']) {
    directory = path.join(directory, segment)
    try { fs.mkdirSync(directory) } catch (error) { if (error.code !== 'EEXIST') throw error }
    if (!fs.lstatSync(directory).isDirectory()) throw new Error('앱의 Maven 설정 폴더를 확인할 수 없습니다.')
  }
  const target = path.join(directory, `${presetId}.xml`)
  const current = fs.lstatSync(target, { throwIfNoEntry: false })
  if (current && !current.isFile()) throw new Error('앱의 Maven 설정 파일을 확인할 수 없습니다.')
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

module.exports = { renderMavenSettings, writeMavenSettings, projectMirrorId }
