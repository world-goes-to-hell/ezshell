const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { createHash } = require('node:crypto')
const { isLocalFilePath } = require('../localKeyPath.js')
const { APACHE_SERIES } = require('./apacheProviders.js')

const APACHE_VERSION = /^\d{1,4}\.\d{1,4}\.\d{1,4}$/
const LOCAL_TOOL_ID = /^local-tool-[0-9a-f]{24}$/
const seriesOf = (tool, version) => APACHE_SERIES[tool].find(series => version?.startsWith(`${series}.`)) ?? null

const LAUNCHERS = {
  tomcat: { win32: 'catalina.bat', unix: 'catalina.sh' },
  maven: { win32: 'mvn.cmd', unix: 'mvn' },
  ant: { win32: 'ant.bat', unix: 'ant' }
}

function hasApacheToolHome(home, tool, platform) {
  if (!Object.hasOwn(LAUNCHERS, tool)) return false
  const bin = path.join(home, 'bin')
  const launcher = LAUNCHERS[tool][platform === 'win32' ? 'win32' : 'unix']
  try {
    if (!fs.lstatSync(home).isDirectory() || !fs.lstatSync(bin).isDirectory() || !fs.lstatSync(path.join(bin, launcher)).isFile()) return false
    if (tool !== 'tomcat') return true
    const conf = path.join(home, 'conf')
    return fs.lstatSync(path.join(bin, 'bootstrap.jar')).isFile() && fs.lstatSync(conf).isDirectory()
      && fs.lstatSync(path.join(conf, 'server.xml')).isFile()
  } catch { return false }
}

function unpackedApacheHome(root, { tool, version }, platform) {
  if (!Object.hasOwn(LAUNCHERS, tool) || typeof version !== 'string' || !APACHE_VERSION.test(version)) {
    throw new Error('요청한 Apache 배포본의 이름이 올바르지 않습니다.')
  }
  const home = path.join(root, `apache-${tool}-${version}`)
  if (!hasApacheToolHome(home, tool, platform)) throw new Error('압축에서 요청한 Apache 도구를 확인할 수 없습니다.')
  return home
}

function tomcatVersion(home) {
  try {
    const notes = path.join(home, 'RELEASE-NOTES')
    const stat = fs.lstatSync(notes)
    if (stat.isFile() && stat.size <= 128 * 1024) {
      return /^[ \t]*Apache Tomcat Version (\d{1,4}\.\d{1,4}\.\d{1,4})[ \t]*\r?$/m.exec(fs.readFileSync(notes, 'utf8'))?.[1] ?? null
    }
  } catch { /* Some distributions omit release notes. */ }
  return null
}

function directoryEntries(directory) {
  try {
    return fs.lstatSync(directory).isDirectory() ? fs.readdirSync(directory, { withFileTypes: true }) : []
  } catch { return [] }
}

function mavenVersionFromHome(home) {
  if (!isLocalFilePath(home)) return undefined
  const versions = directoryEntries(path.join(home, 'lib')).filter(entry => entry.isFile())
    .map(entry => /^maven-core-(\d{1,4}\.\d{1,4}\.\d{1,4})\.jar$/.exec(entry.name)?.[1]).filter(Boolean)
  return versions.length === 1 ? versions[0] : undefined
}

function localVersion(home, tool) {
  if (tool === 'tomcat') {
    const version = tomcatVersion(home)
    if (version) return version
  }
  if (tool === 'maven') {
    const version = mavenVersionFromHome(home)
    if (version) return version
  }
  return new RegExp(`^apache-${tool}-(\\d{1,4}\\.\\d{1,4}\\.\\d{1,4})$`, 'i').exec(path.basename(home))?.[1] ?? null
}

function inspectLocalTool(directory, tool, platform) {
  if (!isLocalFilePath(directory)) return null
  try {
    const home = fs.realpathSync(directory)
    if (!isLocalFilePath(home) || !hasApacheToolHome(home, tool, platform)) return null
    const version = localVersion(home, tool)
    const key = platform === 'win32' ? home.toLowerCase() : home
    const id = `local-tool-${createHash('sha256').update(`${tool}:\0${key}`).digest('hex').slice(0, 24)}`
    return { id, tool, home, version, series: seriesOf(tool, version), managed: false, folder: path.basename(home) }
  } catch { return null }
}

function inspectLocalTomcat6(directory, platform) {
  const entry = inspectLocalTool(directory, 'tomcat', platform)
  return entry?.series === '6' && tomcatVersion(entry.home) === entry.version ? entry : null
}

function childrenMatching(directory, pattern) {
  if (!isLocalFilePath(directory)) return []
  return directoryEntries(directory).filter(entry => entry.isDirectory() && pattern.test(entry.name))
    .map(entry => path.join(directory, entry.name))
}

function findLocalApacheTools({ env = process.env, home = os.homedir(), platform = process.platform, registered = [] } = {}) {
  const tomcat = [env.CATALINA_HOME, ...registered]
  const ide = [env.IDEA_HOME]
  if (platform === 'win32') {
    tomcat.push(...childrenMatching('C:/', /^apache-tomcat-/i))
    for (const base of new Set([env.ProgramFiles, env.ProgramW6432, env['ProgramFiles(x86)']])) {
      if (!isLocalFilePath(base)) continue
      tomcat.push(...childrenMatching(path.join(base, 'Apache Software Foundation'), /^Tomcat/i))
      ide.push(...childrenMatching(path.join(base, 'JetBrains'), /^IntelliJ IDEA/i))
    }
    if (isLocalFilePath(env.LOCALAPPDATA)) {
      ide.push(...childrenMatching(path.join(env.LOCALAPPDATA, 'Programs'), /^IntelliJ IDEA/i))
    }
  } else if (platform === 'darwin') {
    for (const base of ['/Applications', path.join(home, 'Applications')]) {
      ide.push(...childrenMatching(base, /^IntelliJ IDEA.*\.app$/i).map(folder => path.join(folder, 'Contents')))
    }
  }
  const maven = [env.MAVEN_HOME, env.M2_HOME, ...ide.filter(isLocalFilePath).map(folder => path.join(folder, 'plugins', 'maven', 'lib', 'maven3'))]
  const found = new Map()
  for (const [tool, candidates] of Object.entries({ tomcat, maven, ant: [env.ANT_HOME] })) {
    for (const directory of new Set(candidates)) {
      const entry = inspectLocalTool(directory, tool, platform)
      if (entry) found.set(entry.id, entry)
    }
  }
  return [...found.values()]
}

module.exports = { LOCAL_TOOL_ID, seriesOf, hasApacheToolHome, unpackedApacheHome, inspectLocalTomcat6, findLocalApacheTools, mavenVersionFromHome }
