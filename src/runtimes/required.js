const fs = require('node:fs/promises')
const { constants } = require('node:fs')
const path = require('node:path')
const { resolveLocalPreviewPath } = require('../agentChat/localPreview.js')
const { featureOf } = require('./providers.js')

const MAX_BUILD_FILE_BYTES = 1024 * 1024
const READ_FLAGS = constants.O_RDONLY | (process.platform === 'win32' ? 0
  : (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0))
const property = (pom, name) => {
  const tag = name.replaceAll('.', '\\.')
  return new RegExp(`<${tag}>\\s*([^<]+?)\\s*</${tag}>`, 'i').exec(pom)?.[1]
}

function pomVersion(pom) {
  const xml = pom.replace(/<!--[\s\S]*?-->/g, '')
  const major = value => featureOf(value?.trim()) ?? 0
  const resolve = value => {
    const key = /^\$\{([\w.-]+)\}$/.exec(value ?? '')?.[1]
    return key ? property(xml, key) : value
  }
  const declared = ['maven.compiler.source', 'maven.compiler.release', 'java.version'].map(key => major(resolve(property(xml, key))))
  const boot = [...xml.matchAll(/<(?:parent|dependency|plugin)>\s*([\s\S]*?)<\/(?:parent|dependency|plugin)>/g)]
    .some(([, block]) => property(block, 'groupId') === 'org.springframework.boot'
      && /^spring-boot-(?:starter-parent|dependencies|maven-plugin)$/.test(property(block, 'artifactId') ?? '')
      && major(resolve(property(block, 'version'))) === 3)
  return Math.max(...declared, boot ? 17 : 0)
}

function gradleVersion(gradle) {
  const script = gradle.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
  const assignments = [...script.matchAll(/\bsourceCompatibility\s*(?:=\s*|\(\s*|\s+)(?:JavaVersion\.VERSION_)?["']?(\d+(?:[._]\d+)?)/g)]
    .map(([, version]) => featureOf(version.replace('_', '.')) ?? 0)
  const toolchains = [...script.matchAll(/\blanguageVersion\s*(?:=\s*|\.set\(\s*)JavaLanguageVersion\.of\(\s*(\d+)\s*\)/g)]
    .map(([, version]) => Number(version))
  const boot = /\bid\s*\(?\s*["']org\.springframework\.boot["']\s*\)?\s*version\s*\(?\s*["']3\./.test(script)
  return Math.max(0, ...assignments, ...toolchains, boot ? 17 : 0)
}

async function readBuildFile(root, name) {
  try {
    const entry = await resolveLocalPreviewPath(path.join(root, name))
    if (path.relative(root, entry.path) !== name || !entry.stat.isFile() || entry.stat.size > MAX_BUILD_FILE_BYTES) return ''
    const handle = await fs.open(entry.path, READ_FLAGS)
    try {
      const stat = await handle.stat()
      if (!stat.isFile() || stat.size > MAX_BUILD_FILE_BYTES || stat.dev !== entry.stat.dev || stat.ino !== entry.stat.ino) return ''
      const buffer = Buffer.alloc(stat.size)
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0)
      return buffer.toString('utf8', 0, bytesRead)
    } finally { await handle.close() }
  } catch { /* Missing or inaccessible descriptors leave the version unknown. */ }
  return ''
}

/** The main window picks a local folder. Read only its top-level build descriptors and return a version number. */
async function requiredFeature(root) {
  const [pom, groovy, kotlin] = await Promise.all(['pom.xml', 'build.gradle', 'build.gradle.kts'].map(name => readBuildFile(root, name)))
  return Math.max(pomVersion(pom), gradleVersion(groovy), gradleVersion(kotlin)) || null
}

module.exports = { requiredFeature }
