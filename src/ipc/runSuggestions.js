const fs = require('node:fs')
const path = require('node:path')
const { createHash, randomUUID } = require('node:crypto')
const { diagnoseRun } = require('./runDiagnosis.js')
const { normalizeMavenMirrors, projectMirrorId, stageMavenSettings } = require('../runtimes/mavenSettings.js')

const USER_SETTINGS_IMPACT = '이 실행의 사용자 서버 인증·프록시·미러·로컬 저장소 설정을 제외합니다.'
const MIRROR_DIAGNOSES = new Set(['mavenHttpBlocked', 'mavenRepositoryUnavailable'])

function usesMaven(preset) {
  return (preset.kind === 'task' && typeof preset.taskId === 'string' && preset.taskId.endsWith(':maven'))
    || (preset.kind === 'tomcat' && preset.prepare?.tool === 'maven')
}

function mavenFields(preset) {
  if (!usesMaven(preset)) return {}
  const mirrors = normalizeMavenMirrors(preset.mavenMirrors)
  const userSettings = preset.mavenUserSettings
  if (userSettings !== undefined && typeof userSettings !== 'boolean') throw new Error('Maven 사용자 설정의 적용 여부를 확인해 주세요.')
  return {
    ...(mirrors.length && { mavenMirrors: mirrors }),
    ...(userSettings === false && { mavenUserSettings: false })
  }
}

function mavenApproval(preset) {
  const fields = mavenFields(preset)
  if (!fields.mavenMirrors && fields.mavenUserSettings !== false) return null
  const mirrors = fields.mavenMirrors ?? []
  const userSettings = fields.mavenUserSettings !== false
  const text = ['Maven 저장소 설정',
    ...mirrors.map(({ repositoryId, url }) => `${repositoryId} → ${url}`),
    userSettings ? '이 실행의 Maven 설치본 전역 설정을 대체합니다 (-gs).' : USER_SETTINGS_IMPACT + ' (-s)'].join('\n')
  return { text, signature: [preset.kind, preset.taskId, preset.relative, mirrors, userSettings] }
}

const mavenInvocation = preset => usesMaven(preset)
  ? JSON.stringify([preset.kind, preset.taskId, preset.relative, preset.prepare?.goals])
  : null

function diagnosisContext(preset) {
  return { key: randomUUID(), invocation: mavenInvocation(preset),
    mirrors: preset.mavenUserSettings === false ? undefined : preset.mavenMirrors }
}

function applyKind(preset, suggestion, diagnosis) {
  if (!diagnosis.invocation || diagnosis.invocation !== mavenInvocation(preset) || !projectMirrorId(suggestion.repositoryId)) return undefined
  if (MIRROR_DIAGNOSES.has(suggestion.kind)) return 'mavenMirror'
  if (suggestion.kind === 'mavenUserMirror' && preset.mavenUserSettings !== false) {
    const expected = diagnosis.mirrors?.find(mirror => mirror.repositoryId === suggestion.repositoryId)
    if (expected && preset.mavenMirrors?.some(mirror => mirror.repositoryId === expected.repositoryId && mirror.url === expected.url)) {
      return 'mavenUserSettings'
    }
  }
  return undefined
}

function presetSuggestions(preset, run) {
  if (!run?.diagnosis) return []
  const { key, mirrors } = run.diagnosis
  return diagnoseRun({ groups: run.logs.groups(), lines: run.logs.lines(), mirrors }).map(item => {
    const id = createHash('sha256').update(JSON.stringify([key, item])).digest('hex')
    const apply = applyKind(preset, item, run.diagnosis)
    return { ...item, id, ...(apply && { apply }) }
  })
}

function suggestedMavenFields(preset, run, request) {
  const id = request?.id
  if (typeof id !== 'string' || !/^[0-9a-f]{64}$/.test(id)) throw new Error('적용할 진단을 다시 선택해 주세요.')
  const suggestion = presetSuggestions(preset, run).find(item => item.id === id)
  if (!suggestion?.apply) throw new Error('최근 실행에서 적용할 진단을 찾을 수 없습니다. 진단을 다시 확인해 주세요.')
  if (suggestion.apply === 'mavenUserSettings') {
    if (request.replacementUrl !== undefined) throw new Error('Maven 사용자 설정의 적용 여부를 확인해 주세요.')
    return { ...mavenFields(preset), mavenUserSettings: false }
  }
  const repositoryId = suggestion.repositoryId
  const current = (preset.mavenMirrors ?? []).filter(mirror => mirror.repositoryId !== repositoryId)
  return mavenFields({ ...preset, mavenMirrors: [...current, { repositoryId, url: request.replacementUrl }] })
}

function prepareMavenSettings(preset, { userData, mavenVersion } = {}) {
  const fields = mavenFields(preset)
  if (!fields.mavenMirrors && fields.mavenUserSettings !== false) return { args: [] }
  const { file, cleanup } = stageMavenSettings({ userData, presetId: preset.id, mirrors: fields.mavenMirrors, mavenVersion })
  return { args: [fields.mavenUserSettings === false ? '-s' : '-gs', file], cleanup }
}

function appendMavenSettings(command, args, platform = process.platform) {
  if (!args.length) return command
  const [flag, file] = args
  // PowerShell removes its own quotes before forwarding to Maven's cmd wrapper. Keep native
  // double quotes even when the path has no spaces so cmd treats characters such as & literally.
  const quoted = platform === 'win32' ? `'"${file.replaceAll("'", "''")}"'` : `'${file.replaceAll("'", "'\\''")}'`
  return `${command} ${flag} ${quoted}`
}

function wrapperMavenVersion(task) {
  if (!/^\.(?:\\mvnw\.cmd|\/mvnw)\s/.test(task.command)) return undefined
  try {
    const meta = path.join(task.cwd, '.mvn')
    const wrapper = path.join(meta, 'wrapper')
    if (!fs.lstatSync(meta).isDirectory() || !fs.lstatSync(wrapper).isDirectory()) return undefined
    const file = path.join(wrapper, 'maven-wrapper.properties')
    const stat = fs.lstatSync(file)
    if (!stat.isFile() || stat.size > 64 * 1024) return undefined
    const url = /^[ \t]*distributionUrl\s*=\s*([^\s]+)[ \t]*\r?$/m.exec(fs.readFileSync(file, 'utf8'))?.[1]
    return /\/apache-maven-(\d+\.\d+\.\d+)-bin\.(?:zip|tar\.gz)$/.exec(new URL(url?.replace(/\\([:=])/g, '$1')).pathname)?.[1]
  } catch { return undefined }
}

module.exports = { usesMaven, mavenFields, mavenApproval, diagnosisContext, presetSuggestions, suggestedMavenFields,
  prepareMavenSettings, appendMavenSettings, wrapperMavenVersion }
