const { cleanLogLine, MAX_LOG_LINES } = require('./developmentErrors.js')
const { classifyDetail } = require('./logLevels.mjs')
const { redactRunSecrets } = require('./runSecrets.js')
const { projectMirrorId } = require('../runtimes/mavenSettings.js')

const MESSAGES = {
  missingClass: '이 클래스가 들어 있는 JAR를 찾아 클래스패스에 추가할 수 있습니다.',
  jdkVersion: '클래스 파일을 실행할 수 있는 JDK를 선택하세요.',
  jndi: '실행 구성의 JNDI 데이터소스 이름과 서버의 등록 내용을 확인하세요.',
  sourceEncoding: '소스 파일과 컴파일 설정의 인코딩이 일치하는지 확인하세요.',
  portInUse: '실행 포트를 사용 중인 프로세스를 확인하세요.',
  databaseConnection: 'DB가 실행 중이고 설정한 호스트와 포트에서 접속할 수 있는지 확인하세요.',
  databaseAuth: 'DB 사용자 이름, 비밀번호, 접속 권한을 확인하세요.',
  databaseMissing: '설정한 데이터베이스 이름과 DB에 해당 데이터베이스가 있는지 확인하세요.',
  mavenHttpBlocked: '차단된 HTTP 저장소를 대신할 HTTPS 주소나 로컬 보관소를 확인하세요.',
  mavenRepositoryUnavailable: '저장소 주소와 접속 가능 여부를 확인하세요.',
  mavenUnauthorized: 'Maven 저장소 접근 권한을 확인하세요.',
  mavenTls: 'Maven을 실행하는 JDK의 TLS 지원과 저장소 인증서를 확인하세요.',
  mavenArtifactMissing: '의존성 좌표를 확인하고 프로젝트에 필요한 JAR를 찾아보세요.',
  mavenPluginJdk: '빌드 플러그인이 요구하는 JDK와 Maven을 실행하는 JDK를 확인하세요.',
  mavenUserMirror: '사용자 미러가 선택됐습니다. 별도 승인 후 프로젝트 설정을 사용자 설정으로 지정해 재시도할 수 있습니다. 이때 사용자 서버 인증·프록시·미러·로컬 저장소 설정이 적용되지 않습니다.'
}

const CLASS_NAME = /^[$_\p{ID_Start}][$\p{ID_Continue}]*(?:[/.][$_\p{ID_Start}][$\p{ID_Continue}]*)*$/u
const ARTIFACT = /\bCould not find artifact\s+([A-Za-z0-9_.-]+:[A-Za-z0-9_.-]+(?::[A-Za-z0-9_.+-]+){2,3})(?=[\s,)]|$)/i
const REPOSITORY = /\b(?:from\/to|from|in)\s+([A-Za-z0-9][A-Za-z0-9_.-]{0,127})\s*\((?:https?|file):\/\/[^\s)]+\)/i
const BLOCKED_REPOSITORY = /([A-Za-z0-9][A-Za-z0-9_.-]{0,127})\s*\(https?:\/\/[^\s,)]+/gi
const MAVEN_BUILD = /Failed to execute goal|Failed to read artifact descriptor|(?:Non-resolvable|Unresolvable) parent POM|Could not (?:find|transfer|resolve) artifact|The following artifacts could not be resolved|Plugin\s+[\w.-]+:[\w.-]+(?::[\w.-]+)?|org\.(?:apache\.maven|eclipse\.aether)\./i
const MAVEN_TRANSFER = /artifact|dependencies|dependency|repository|could not be resolved|parent POM|org\.(?:apache\.maven\.wagon|eclipse\.aether)\./i
const MAVEN_PLUGIN = /Failed to execute goal|Plugin\s+[\w.-]+:[\w.-]+|ClassRealm\[plugin>|realm\s*=\s*plugin>/i
const TRANSFER_CAUSE = /^\s*Caused by:.*\b(?:UnknownHostException|SSLHandshakeException|SunCertPathBuilderException)\b/i
const SELECTED_MIRROR = /\bUsing mirror\s+([A-Za-z0-9][A-Za-z0-9_.-]{0,135})\s+\((.*?)\)\s+for\s+([A-Za-z0-9][A-Za-z0-9_.-]{0,127})\s+\(/
const PORT_BUSY = /\bEADDRINUSE\b|\baddress already in use\b|\bPort\s+\d+\s+(?:is|was)\s+(?:already )?in use\b/i
const PORT_CONTEXT = /\b(?:http|https|ajp)-(?:jsse-|openssl-)?(?:nio2?|apr|bio)-([0-9]{1,5})\b|\bConnector\[(?:HTTP|AJP)\/[\d.]+-([0-9]{1,5})\]/i
const OBSOLETE_JVM_OPTION = /\bUnrecognized VM option ['"](?:[+-])?(MaxPermSize|PermSize|UseConcMarkSweepGC|UseParNewGC|CMSIncrementalMode|UseCMSCompactAtFullCollection|CMSClassUnloadingEnabled|AggressiveOpts)(?:=[^'"\r\n]*)?['"]/i

const DATABASE_LOG = /\b(?:SqlExceptionHelper|JDBCConnectionException|PSQLException)\b|\b(?:org\.mariadb\.jdbc|com\.mysql|org\.postgresql|com\.microsoft\.sqlserver\.jdbc)\.|\bjdbc:[\w+-]+:|\bSocket fail to connect to host:address=\(host=/i
const CONNECTION_REFUSED = /\b(?:ECONNREFUSED|connection refused)\b|\bConnection to\s+\S+\s+refused\b/i
const CONNECTION_TIMEOUT = /\b(?:ETIMEDOUT|(?:connection|connect) timed out|connect timeout)\b/i
const STACK_FRAME = /^\s*(?:at\s|\.\.\. \d+|Traceback\b|File ")/

function positiveInteger(value, limit) {
  const number = Number(value)
  return Number.isInteger(number) && number > 0 && number <= limit ? number : null
}

function classVersion(line) {
  const version = /\b(?:class file (?:has wrong )?version|Unsupported major\.minor version)\s+(\d{2,5})\.(\d{1,5})\b/i.exec(line)
  const major = positiveInteger(version?.[1], 65535)
  return major && major >= 45 ? { requiredFeature: major - 44, classMajor: major, ...(version[2] === '65535' && { preview: true }) } : null
}

function missingClass(line) {
  if (/NoClassDefFoundError:\s*Could not initialize class\b|\(wrong name:/i.test(line)) return null
  const name = /\b(?:ClassNotFoundException|NoClassDefFoundError):\s*([^\s,;()]+)/.exec(line)?.[1]
  return name && name.length <= 256 && CLASS_NAME.test(name) ? name.replaceAll('/', '.') : null
}

function busyPort(line, nearby) {
  const named = /\bPort\s+(\d{1,5})\s+(?:is|was)\s+(?:already )?in use/i.exec(line)?.[1]
  const endpoint = /\b(?:EADDRINUSE|address already in use)\b.*?:([0-9]{1,5})(?:\s|$)/i.exec(line)?.[1]
  if (named || endpoint) return positiveInteger(named ?? endpoint, 65535)
  const ports = new Set(nearby.map(row => {
    const context = PORT_CONTEXT.exec(row)
    return positiveInteger(context?.[1] ?? context?.[2], 65535)
  }).filter(Boolean))
  return ports.size === 1 ? ports.values().next().value : null
}

function connectionPort(line) {
  const named = /\bport\s*(?:=\s*)?(\d{1,5})(?!\d)/i.exec(line)?.[1]
  const endpoint = /(?:\b(?:ECONNREFUSED|ETIMEDOUT|connection to|connect to)\s+|\bjdbc:[\w+-]+:\/\/)(?:\[[\da-f:]+\]|[\w.-]+):(\d{1,5})(?!\d)/i.exec(line)?.[1]
  return positiveInteger(named ?? endpoint, 65535)
}

function inspectDatabase(line, preceding, errorLine, add) {
  // A nested socket exception inherits the immediately enclosing error, skipping frames.
  const parent = errorLine && /^\s*Caused by:/i.test(line)
    ? preceding.find(row => !STACK_FRAME.test(row)) : undefined
  const evidence = DATABASE_LOG.test(line) ? line
    : parent && DATABASE_LOG.test(parent) && classifyDetail(parent).level === 'error' ? parent : undefined
  if (!evidence) return
  if (/\b(?:access denied for user|password authentication failed|login failed for user|SQLState\s*:\s*28(?:000|P01))\b/i.test(line)) {
    add('databaseAuth')
  } else if (/\bunknown database\b|\bdatabase ['"][^'"]+['"] does not exist\b/i.test(line)) {
    add('databaseMissing')
  } else if (CONNECTION_REFUSED.test(line) || CONNECTION_TIMEOUT.test(line)) {
    add('databaseConnection', { port: connectionPort(line) ?? connectionPort(evidence),
      reason: CONNECTION_REFUSED.test(line) ? 'refused' : 'timeout' })
  }
}

function repositoryId(line) {
  const id = REPOSITORY.exec(line)?.[1]
  return id !== 'maven-default-http-blocker' ? id : undefined
}

function normalizedUrl(value) {
  try { return new URL(value).href.replace(/\/$/, '') } catch { return null }
}

function inspectMirrorSelection(line, mirrors, add) {
  const selection = SELECTED_MIRROR.exec(line)
  if (!selection) return
  const [, mirrorId, url, repositoryId] = selection
  const expected = mirrors.get(repositoryId)
  if (!expected || mirrorId === 'maven-default-http-blocker') return
  const actualUrl = normalizedUrl(url)
  if (mirrorId === expected.id && (!actualUrl || actualUrl === expected.url)) return
  add('mavenUserMirror', { repositoryId, mirrorId, settingsFlag: '-s', requiresApproval: true })
}

function inspectMaven(line, nearby, transferContext, add) {
  if (/Blocked mirror for repositories:/i.test(line) || (/\bmaven-default-http-blocker\b/i.test(line) && MAVEN_BUILD.test(line))) {
    const blocked = line.split(/Blocked mirror for repositories:/i)[1] ?? ''
    const ids = [...blocked.matchAll(BLOCKED_REPOSITORY)].map(match => match[1])
    if (ids.length) for (const id of ids) add('mavenHttpBlocked', { repositoryId: id })
    else add('mavenHttpBlocked')
    return
  }
  const context = nearby.find(row => MAVEN_BUILD.test(row) && MAVEN_TRANSFER.test(row))
    ?? (TRANSFER_CAUSE.test(line) ? transferContext : undefined)
  if (context) {
    const id = repositoryId(line) ?? repositoryId(context)
    const repository = id ? { repositoryId: id } : {}
    if (/\b(?:status(?: code)?|return code is)\s*[:=]?\s*401\b|\b401\s+Unauthorized\b|\bUnauthorized\s*\(401\)/i.test(line)) {
      add('mavenUnauthorized', repository)
    } else if (/\bUnknownHostException\b|\bName or service not known\b|\bNo such host is known\b|\bTemporary failure in name resolution\b|\bUnknown host\b/i.test(line)) {
      add('mavenRepositoryUnavailable', { ...repository, reason: 'unknownHost' })
    } else if (/\b(?:status(?: code)?|return code is)\s*[:=]?\s*404\b|\b404\s+Not Found\b/i.test(line)) {
      add('mavenRepositoryUnavailable', { ...repository, reason: 'notFound' })
    } else if (/\bPKIX\b|\bSunCertPathBuilderException\b|\bSSLHandshakeException\b|\bhandshake_failure\b|\bprotocol_version\b/i.test(line)) {
      add('mavenTls', repository)
    } else {
      const artifact = ARTIFACT.exec(line)?.[1]
      if (artifact) add('mavenArtifactMissing', { ...repository, artifact })
    }
  }

  if (!nearby.some(row => MAVEN_PLUGIN.test(row))) return
  const required = /\b(?:requires (?:at least )?(?:Java|JDK)(?: version)?\s+|invalid target release:\s*)(?:1\.)?(\d{1,3})\b/i.exec(line)?.[1]
    ?? /\brelease version\s+(?:1\.)?(\d{1,3})\s+not supported\b/i.exec(line)?.[1]
  const feature = positiveInteger(required, 999)
  if (feature) add('mavenPluginJdk', { requiredFeature: feature })
  else if (/\bUnsupportedClassVersionError\b/.test(line)) {
    add('mavenPluginJdk', classVersion(line) ?? {})
  } else if (/\binvalid flag:\s*--release\b/i.test(line)) add('mavenPluginJdk')
}

/**
 * Accepts createDevelopmentErrors().groups() and/or its recent lines(). Pass the approved mirrors
 * used for the invocation to diagnose Maven's debug messages about effective mirror selection.
 */
function diagnoseRun({ groups = [], lines = [], mirrors = [], maven = true } = {}) {
  const suggestions = new Map()
  const add = (kind, fields = {}) => {
    const key = JSON.stringify([kind, fields])
    const message = kind === 'mavenObsoleteJvmOption'
      ? `MAVEN_OPTS와 .mvn/jvm.config에서 현재 JDK가 지원하지 않는 ${fields.option} 옵션을 확인하고 제거하세요.`
      : kind === 'jdkVersion' && fields.preview
      ? '클래스를 컴파일한 버전과 같은 JDK에서 미리보기 기능 설정을 확인하세요.'
      : MESSAGES[kind]
    if (!suggestions.has(key)) suggestions.set(key, { kind, message, ...fields })
  }
  const expectedMirrors = new Map()
  if (Array.isArray(mirrors)) {
    for (const mirror of mirrors) {
      const id = projectMirrorId(mirror?.repositoryId)
      const url = normalizedUrl(mirror?.url)
      if (id && url) expectedMirrors.set(mirror.repositoryId, { id, url })
    }
  }
  const blocks = Array.isArray(groups) ? groups.slice(-20).map(group => ({ lines: group?.lines, errorGroup: true })) : []
  blocks.push({ lines, errorGroup: false })
  for (const block of blocks) {
    if (!Array.isArray(block.lines)) continue
    const rows = block.lines.slice(-MAX_LOG_LINES).filter(line => typeof line === 'string').map(line => cleanLogLine(line.slice(0, 8192)))
    let transferContext
    let rawError
    for (const [index, line] of rows.entries()) {
      // Include a short stack trace or a Tomcat connector description in the same diagnostic.
      const preceding = rows.slice(Math.max(0, index - 6), index).reverse()
      const nearby = [line, ...preceding, ...rows.slice(index + 1, index + 4)]
      const detail = classifyDetail(line)
      if (detail.explicit || /^\s*Exception in thread\b/.test(line)) rawError = detail.level === 'error'
      else if (detail.level !== 'error') rawError = undefined
      const errorLine = block.errorGroup || (detail.level === 'error' && rawError !== false)
      if (errorLine) {
        const name = missingClass(line)
        if (name) add('missingClass', { className: name })
      }
      const version = classVersion(line)
      if (/\bUnsupportedClassVersionError\b/.test(line)) {
        add('jdkVersion', version ?? classVersion(rows[index + 1] ?? '') ?? { requiredFeature: null })
      } else if (version && /\bclass file has wrong version\b/.test(line)) add('jdkVersion', version)
      if (errorLine && /\bNameNotFoundException\b/.test(line)) {
        const resource = /\bjdbc\/[A-Za-z0-9_$.-]+(?:\/[A-Za-z0-9_$.-]+)*/.exec(line)?.[0]
        if (resource) add('jndi', { name: resource })
      }
      if (/\bunmappable character\b/i.test(line)) {
        const encoding = /\bfor encoding\s+([A-Za-z0-9_.-]{1,40})/i.exec(line)?.[1]
        add('sourceEncoding', encoding ? { encoding } : {})
      }
      if (PORT_BUSY.test(line)) add('portInUse', { port: busyPort(line, nearby) })
      if (!detail.explicit || detail.level === 'error') inspectDatabase(line, preceding, errorLine, add)
      if (/\bCould not transfer artifact\b/i.test(line)) transferContext = line
      inspectMaven(line, nearby, transferContext, add)
      const obsolete = maven && OBSOLETE_JVM_OPTION.exec(line)?.[1]
      if (obsolete) add('mavenObsoleteJvmOption', { option: obsolete })
      if (expectedMirrors.size) inspectMirrorSelection(line, expectedMirrors, add)
    }
  }
  const results = [...suggestions.values()]
  const withoutRepository = ({ repositoryId: _repositoryId, ...item }) => JSON.stringify(item)
  const detailed = new Set(results.filter(item => item.repositoryId).map(withoutRepository))
  return results.filter(item => item.repositoryId || !detailed.has(withoutRepository(item)))
}

const FAILURE_SUMMARY_LIMIT = 160
const EXIT_FOOTER = /^(?:\[Help \d+\]|https?:\/\/|(?:APPLICATION FAILED TO START|BUILD (?:FAILURE|FAILED))\b|FAILURE:\s+Build failed\b|To see the full stack trace\b|Re-run Maven\b|For more information about the errors\b|Run with --(?:stacktrace|info|debug|scan)\b|Get more help at\b)|\b(?:process (?:terminated|exited) with exit code|returned exit code)\b/i
const FAILURE_DETAIL = /\[vite\]\s+Internal server error\b|\berror TS\d+\b|\b(?:could not find or load main class|command not found|is not recognized as an internal or external command)\b/i
const FAILURE_REASONS = {
  portInUse: ({ port }) => `실행 포트 점검 · ${port ? `${port} ` : ''}포트 사용 중`,
  databaseConnection: ({ port, reason }) => `DB 점검 필요 · ${port ? `${port} 포트 ` : ''}연결 ${reason === 'timeout' ? '시간 초과' : '실패'}`,
  databaseAuth: () => 'DB 점검 필요 · 로그인 또는 접속 권한 오류',
  databaseMissing: () => 'DB 설정 점검 · 지정한 데이터베이스 없음',
  jdkVersion: ({ requiredFeature, preview }) => preview ? 'JDK 점검 · Java 미리보기 기능 설정 불일치'
    : requiredFeature ? `JDK 점검 · Java ${requiredFeature} 이상 필요` : 'JDK 점검 · 클래스 버전 불일치',
  missingClass: ({ className }) => `의존성 점검 · ${className} 클래스 없음`,
  jndi: ({ name }) => `DB 설정 점검 · JNDI 데이터소스 ${name} 없음`,
  sourceEncoding: () => '빌드 설정 점검 · 소스 인코딩 불일치',
  mavenHttpBlocked: () => 'Maven 저장소 점검 · HTTP 접속 차단',
  mavenRepositoryUnavailable: ({ reason }) => reason === 'unknownHost'
    ? 'Maven 저장소 점검 · 호스트 이름 조회 실패' : 'Maven 저장소 점검 · 저장소 주소를 찾을 수 없음',
  mavenUnauthorized: () => 'Maven 저장소 점검 · 인증 실패',
  mavenTls: () => 'Maven 저장소 점검 · TLS 연결 실패',
  mavenArtifactMissing: ({ artifact }) => `Maven 의존성 점검 · ${artifact} 없음`,
  mavenPluginJdk: ({ requiredFeature }) => requiredFeature ? `Maven 빌드 점검 · Java ${requiredFeature} 지원 JDK 필요`
    : 'Maven 빌드 점검 · 플러그인과 JDK 버전 불일치',
  mavenObsoleteJvmOption: ({ option }) => `JVM 옵션 점검 · ${option}은 현재 JDK에서 지원하지 않음`
}

const OTHER_FAILURES = [
  [/\bFailed to configure a DataSource:.*['"]url['"] attribute is not specified\b/i, 'DB 설정 점검 · 데이터소스 URL 누락'],
  [/\bFailed to configure a DataSource\b/i, 'DB 설정 점검 · 데이터소스 구성 실패'],
  [/\bJAVA_HOME\b.*(?:not (?:set|defined)|invalid)|\bNo Java installation\b/i, 'JDK 점검 · Java 실행 환경을 찾을 수 없음'],
  [/\bUnrecognized VM option\b|\bCould not create the Java Virtual Machine\b/i, 'JVM 옵션 점검 · Java 가상 머신 시작 실패'],
  [/\b(?:ERR_PNPM_UNSUPPORTED_ENGINE|EBADENGINE)\b/i, 'Node.js 버전 점검 · 프로젝트 요구 버전과 불일치'],
  [/\b(?:Cannot find module|ERR_MODULE_NOT_FOUND)\b/i, '의존성 점검 · Node 모듈을 찾을 수 없음'],
  [/\b(?:ERESOLVE unable to resolve dependency tree|Could not resolve all (?:files|dependencies) for configuration)\b/i,
    '의존성 점검 · 빌드에 필요한 패키지 또는 버전을 해결하지 못함'],
  [/\b(?:error TS\d+|compilation (?:failed|failure)|cannot find symbol)\b/i, '빌드 점검 · 컴파일 오류'],
  [/\b(?:EACCES|EPERM|permission denied|access is denied)\b/i, '권한 점검 · 파일 또는 실행 권한 부족'],
  [/\b(?:OutOfMemoryError|JavaScript heap out of memory|Could not reserve enough space for object heap)\b/i, '메모리 점검 · 실행에 필요한 메모리 부족'],
  [/\b(?:getaddrinfo (?:ENOTFOUND|EAI_AGAIN)|UnknownHostException)\b/i, '연결 대상 점검 · 호스트 이름 조회 실패'],
  [/\b(?:ENOENT|no such file or directory|could not find or load main class|command not found|is not recognized as an internal or external command)\b/i,
    '실행 환경 점검 · 필요한 파일 또는 명령을 찾을 수 없음']
]

function otherFailureReason(line) {
  const setting = /\bCould not resolve placeholder ['"]([\w.-]{1,80})['"]/i.exec(line)?.[1]
  if (setting) return `설정 점검 · ${setting} 값 누락`
  if (CONNECTION_REFUSED.test(line) || CONNECTION_TIMEOUT.test(line)) {
    const port = connectionPort(line)
    return `연결 대상 점검 · ${port ? `${port} 포트 ` : ''}연결 ${CONNECTION_REFUSED.test(line) ? '실패' : '시간 초과'}`
  }
  return OTHER_FAILURES.find(([pattern]) => pattern.test(line))?.[1]
}

function failureLine(line) {
  return line.trim().replace(/^(?:\[(?:ERROR|ERR|FATAL|SEVERE|vite)\]\s*|(?:ERROR|ERR|FATAL|SEVERE)[\s:]+|Caused by:\s*)+/i, '')
}

function failureSummary(text) {
  const summary = redactRunSecrets(text).replace(/\s+/g, ' ').trim()
  return summary.length > FAILURE_SUMMARY_LIMIT ? `${summary.slice(0, FAILURE_SUMMARY_LIMIT - 1)}…` : summary
}

function describeRunFailure({ lines = [], exitCode, maven = false } = {}) {
  const rows = lines.slice(-MAX_LOG_LINES).map(cleanLogLine)
  const findings = diagnoseRun({ lines: rows, maven })
  const last = findings.findLast(item => FAILURE_REASONS[item.kind])
  if (last) {
    const specific = ['portInUse', 'databaseConnection'].includes(last.kind) && !last.port
      ? findings.findLast(item => item.kind === last.kind && item.reason === last.reason && item.port) ?? last : last
    return failureSummary(FAILURE_REASONS[specific.kind](specific))
  }
  const other = rows.map(line => {
    const detail = classifyDetail(line)
    return detail.explicit && detail.level !== 'error' ? undefined : otherFailureReason(line)
  }).findLast(Boolean)
  if (other) return failureSummary(other)

  const description = rows.findLastIndex(line => /^\s*(?:Description|\* What went wrong):\s*$/.test(line))
  if (description >= 0 && rows.slice(0, description).some(line => /APPLICATION FAILED TO START|FAILURE:\s+Build failed/i.test(line))) {
    const reason = rows.slice(description + 1).find(line => line.trim())
    if (reason && !/^\s*(?:Action|\*[^:]*):/.test(reason)) return failureSummary(failureLine(reason))
  }
  const detail = rows.findLast(line => {
    if (STACK_FRAME.test(line)) return false
    const text = failureLine(line)
    return !!text && !EXIT_FOOTER.test(text) &&
      (classifyDetail(line).level === 'error' || FAILURE_DETAIL.test(line))
  })
  if (detail) return failureSummary(failureLine(detail))
  return Number.isInteger(exitCode) ? `종료 코드 ${exitCode}만 확인됩니다. 로그를 확인해 주세요.`
    : '오류 원인을 확인하지 못했습니다. 로그를 확인해 주세요.'
}

module.exports = { diagnoseRun, describeRunFailure }
