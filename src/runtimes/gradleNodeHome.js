const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { createHash } = require('node:crypto')
const { isLocalFilePath } = require('../localKeyPath.js')

const local = value => isLocalFilePath(value) && path.isAbsolute(value)
const GRADLE_VERSION = '\\d{1,4}\\.\\d{1,4}(?:\\.\\d{1,4})?'
const NODE_VERSION = '\\d{1,4}\\.\\d{1,4}\\.\\d{1,4}'
const GRADLE_FOLDER = new RegExp(`^gradle-(${GRADLE_VERSION})$`, 'i')
const NODE_FOLDER = new RegExp(`^(?:node-)?v(${NODE_VERSION})(?:-[a-z0-9-]+)?$`, 'i')

function launcherName(tool, platform) {
  return tool === 'gradle' ? (platform === 'win32' ? 'gradle.bat' : 'gradle') : (platform === 'win32' ? 'node.exe' : 'node')
}

function launcherPath(home, tool, platform) {
  const parts = tool === 'node' && platform === 'win32' ? [] : ['bin']
  return path.join(home, ...parts, launcherName(tool, platform))
}

function hasGradleNodeHome(home, tool, platform) {
  if (tool !== 'gradle' && tool !== 'node') return false
  try {
    const executable = launcherPath(home, tool, platform)
    return fs.lstatSync(home).isDirectory() && fs.lstatSync(path.dirname(executable)).isDirectory()
      && fs.lstatSync(executable).isFile()
  } catch { return false }
}

function unpackedGradleNodeHome(root, build, platform) {
  const { tool, version, distributionFolder } = build
  const valid = tool === 'gradle' ? GRADLE_FOLDER.exec(distributionFolder) : NODE_FOLDER.exec(distributionFolder)
  if (!valid || valid[1] !== version) throw new Error('개발 도구 배포 폴더를 확인할 수 없습니다.')
  const home = path.join(root, distributionFolder)
  if (!hasGradleNodeHome(home, tool, platform)) throw new Error('압축에서 요청한 개발 도구를 확인할 수 없습니다.')
  if (tool === 'gradle' && platform !== 'win32') {
    const executable = launcherPath(home, tool, platform)
    fs.chmodSync(executable, fs.lstatSync(executable).mode | 0o111)
  }
  return home
}

function entries(directory) {
  if (!local(directory)) return []
  try {
    return fs.lstatSync(directory).isDirectory() ? fs.readdirSync(directory, { withFileTypes: true }) : []
  } catch { return [] }
}

const subdirectories = (directory, pattern) => entries(directory).filter(entry => entry.isDirectory() && pattern.test(entry.name))
  .map(entry => path.join(directory, entry.name))

function localVersion(home, tool) {
  const name = path.basename(home)
  if (tool === 'node') return NODE_FOLDER.exec(name)?.[1] ?? null
  const folders = GRADLE_FOLDER.exec(name)?.[1]
  if (folders) return folders
  const launchers = new Set(entries(path.join(home, 'lib')).filter(entry => entry.isFile())
    .map(entry => new RegExp(`^gradle-launcher-(${GRADLE_VERSION})\\.jar$`, 'i').exec(entry.name)?.[1]).filter(Boolean))
  return launchers.size === 1 ? launchers.values().next().value : null
}

function binaryHome(directory, tool, platform) {
  if (!local(directory)) return null
  try {
    const file = fs.realpathSync(path.join(directory, launcherName(tool, platform)))
    if (!local(file)) return null
    const bin = path.dirname(file)
    return tool === 'node' && platform === 'win32' ? bin : path.dirname(bin)
  } catch { return null }
}

function findLocalGradleNodeTools({ env = process.env, home = os.homedir(), platform = process.platform } = {}) {
  const gradle = [env.GRADLE_HOME]
  const node = [env.NODE_HOME, env.NVM_SYMLINK]
  for (const directory of new Set([env.GRADLE_USER_HOME, path.join(home, '.gradle')])) {
    if (!local(directory)) continue
    const distributions = path.join(directory, 'wrapper', 'dists')
    for (const origin of subdirectories(distributions, /^gradle-\d.*-(?:bin|all)$/i)) {
      for (const hash of subdirectories(origin, /^[a-z0-9]+$/i)) gradle.push(...subdirectories(hash, GRADLE_FOLDER))
    }
  }
  node.push(...subdirectories(path.join(home, '.nvm', 'versions', 'node'), NODE_FOLDER))
  if (local(env.NVM_HOME)) node.push(...subdirectories(env.NVM_HOME, NODE_FOLDER))
  if (platform === 'win32') {
    for (const directory of new Set([env.ProgramFiles, env.ProgramW6432, env['ProgramFiles(x86)']])) {
      if (!local(directory)) continue
      node.push(path.join(directory, 'nodejs'))
      gradle.push(...subdirectories(path.join(directory, 'Gradle'), GRADLE_FOLDER))
    }
  }
  for (const dir of new Set((env.PATH ?? env.Path ?? '').split(platform === 'win32' ? ';' : ':'))) {
    const directory = dir.trim().replace(/^"(.*)"$/, '$1')
    gradle.push(binaryHome(directory, 'gradle', platform))
    node.push(binaryHome(directory, 'node', platform))
  }
  const found = new Map()
  for (const [tool, candidates] of Object.entries({ gradle, node })) {
    for (const directory of new Set(candidates.filter(local))) {
      try {
        const real = fs.realpathSync(directory)
        if (!local(real) || !hasGradleNodeHome(real, tool, platform)) continue
        const key = platform === 'win32' ? real.toLowerCase() : real
        const id = `local-tool-${createHash('sha256').update(`${tool}:\0${key}`).digest('hex').slice(0, 24)}`
        found.set(id, { id, tool, home: real, version: localVersion(real, tool), series: null, managed: false, folder: path.basename(real) })
      } catch { /* A discovered path can disappear between checks. */ }
    }
  }
  return [...found.values()]
}

module.exports = { findLocalGradleNodeTools, hasGradleNodeHome, unpackedGradleNodeHome }
