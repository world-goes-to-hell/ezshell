const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { createHash } = require('node:crypto')
const { isLocalFilePath } = require('../localKeyPath.js')
const { featureOf, VERSION } = require('./providers.js')

const ARCH = { amd64: 'x64', x86_64: 'x64', aarch64: 'arm64', x86: 'ia32', i386: 'ia32', i686: 'ia32', ppc64le: 'ppc64' }

function parseRelease(text, folder = '') {
  const values = new Map()
  for (const line of text.split(/\r?\n/)) {
    const match = /^([A-Z_]+)=(?:"([^"\r\n]*)"|([^"\s]+))$/.exec(line.trim())
    if (match) values.set(match[1], match[2] ?? match[3])
  }
  const version = values.get('JAVA_RUNTIME_VERSION') ?? values.get('JAVA_VERSION')
  const feature = featureOf(version)
  if (!VERSION.test(version) || !feature) return null
  const implementor = values.get('IMPLEMENTOR') ?? values.get('JAVA_VENDOR')
  const provider = `${implementor ?? ''} ${folder}`
  const vendor = /adoptium|temurin/i.test(provider) ? 'temurin' : /azul|zulu/i.test(provider) ? 'zulu' : implementor?.slice(0, 80) || '기타'
  const rawArch = values.get('OS_ARCH')?.toLowerCase()
  const arch = Object.hasOwn(ARCH, rawArch) ? ARCH[rawArch] : /^[a-z0-9_-]{1,16}$/.test(rawArch ?? '') ? rawArch : 'unknown'
  return { vendor, version, feature, arch }
}

function readRelease(home, platform) {
  try {
    const executable = name => path.join(home, 'bin', platform === 'win32' ? `${name}.exe` : name)
    if (!fs.statSync(executable('java')).isFile() || !fs.statSync(executable('javac')).isFile()) return null
    const release = path.join(home, 'release')
    const stat = fs.lstatSync(release)
    if (!stat.isFile() || stat.size > 64 * 1024) return null
    return parseRelease(fs.readFileSync(release, 'utf8'), path.basename(home))
  } catch { return null }
}

function candidateHomes(folder, platform) {
  return platform === 'darwin' ? [folder, path.join(folder, 'Contents', 'Home')] : [folder]
}

function childFolders(folder) {
  try {
    return fs.readdirSync(folder, { withFileTypes: true }).filter(entry => entry.isDirectory() || entry.isSymbolicLink())
      .map(entry => path.join(folder, entry.name))
  } catch { return [] }
}

function findLocalJdks({ env = process.env, home = os.homedir(), platform = process.platform } = {}) {
  const roots = [path.join(home, '.jdks'), path.join(home, '.gradle', 'jdks')]
  if (platform === 'win32') {
    for (const base of new Set([env.ProgramFiles, env.ProgramW6432, env['ProgramFiles(x86)']])) {
      if (isLocalFilePath(base)) roots.push(...['Java', 'Eclipse Adoptium', 'Zulu'].map(vendor => path.join(base, vendor)))
    }
  }
  if (platform === 'darwin') roots.push('/Library/Java/JavaVirtualMachines')
  const candidates = [env.JAVA_HOME, ...roots.filter(isLocalFilePath).flatMap(root => childFolders(root))]
  const found = new Map()
  for (const candidate of candidates.filter(isLocalFilePath)) {
    for (const name of candidateHomes(candidate, platform)) {
      let real
      try { real = fs.realpathSync(name) } catch { continue }
      if (!isLocalFilePath(real)) continue
      const key = platform === 'win32' ? real.toLowerCase() : real
      if (found.has(key)) continue
      const release = readRelease(real, platform)
      if (!release) continue
      const id = `local-${createHash('sha256').update(key).digest('hex').slice(0, 24)}`
      const folder = path.basename(real) === 'Home' && path.basename(path.dirname(real)) === 'Contents'
        ? path.basename(path.dirname(path.dirname(real))) : path.basename(real)
      found.set(key, { id, ...release, managed: false, folder, home: real })
    }
  }
  return [...found.values()]
}

/** The verified JDK home and its enclosing folder in an archive. Preserve a macOS bundle if present. */
function unpackedHome(root, platform, feature) {
  const matches = []
  for (const folder of [root, ...childFolders(root)]) {
    for (const home of candidateHomes(folder, platform)) {
      if (readRelease(home, platform)?.feature === feature) matches.push({ folder, relativeHome: path.relative(folder, home) || '.' })
    }
  }
  if (matches.length !== 1) throw new Error('압축 파일에서 요청한 버전의 JDK를 확인할 수 없습니다.')
  return matches[0]
}

module.exports = { findLocalJdks, unpackedHome, parseRelease, readRelease }
