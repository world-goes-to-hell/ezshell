const { readJson, readText } = require('./download.js')

const GRADLE_API = 'https://services.gradle.org/versions/current'
const GRADLE_DISTRIBUTIONS = 'https://services.gradle.org/distributions'
const NODE_DISTRIBUTIONS = 'https://nodejs.org/dist'
const GRADLE_VERSION = /^\d{1,4}\.\d{1,4}(?:\.\d{1,4})?$/
const NODE_VERSION = /^v\d{1,4}\.\d{1,4}\.\d{1,4}$/
const GRADLE_LICENSE_URL = 'https://www.apache.org/licenses/LICENSE-2.0'
const NODE_LICENSE_URL = 'https://github.com/nodejs/node/blob/main/LICENSE'
const NODE_ARCHITECTURES = {
  win32: { x64: 'x64', arm64: 'arm64', ia32: 'x86' },
  darwin: { x64: 'x64', arm64: 'arm64' },
  linux: { x64: 'x64', arm64: 'arm64', arm: 'armv7l', ppc64: 'ppc64le', s390x: 's390x', riscv64: 'riscv64' }
}

/**
 * The release API and official checksum response are the trust sources. The Gradle download
 * may redirect to github.com / release-assets.githubusercontent.com, and .sha256 to
 * downloads.gradle.org. The shared downloader must validate every redirect.
 */
async function findGradleBuild({ request, signal, loadJson = readJson, loadText = readText } = {}) {
  const options = { request, signal }
  const release = await loadJson(GRADLE_API, options)
  if (typeof release?.version !== 'string' || !GRADLE_VERSION.test(release.version) || release.broken === true) return null
  const { version } = release
  const filename = `gradle-${version}-bin.zip`
  const url = `${GRADLE_DISTRIBUTIONS}/${filename}`
  if (release.downloadUrl !== url || release.checksumUrl !== `${url}.sha256`) return null
  const checksum = await loadText(release.checksumUrl, { ...options, maxBytes: 4096 })
  const match = /^([a-f0-9]{64})(?:[ \t]+\*?([^\r\n]+))?$/i.exec(checksum?.trim() ?? '')
  if (!match || (match[2] && match[2] !== filename)) throw new Error('Gradle이 공개한 SHA-256을 확인할 수 없습니다.')
  return { tool: 'gradle', series: 'current', version, archive: 'zip', url, sha256: match[1].toLowerCase(),
    distributionFolder: `gradle-${version}`, licenseUrl: GRADLE_LICENSE_URL }
}

function nodePackage(platform, arch) {
  if (!Object.hasOwn(NODE_ARCHITECTURES, platform) || !Object.hasOwn(NODE_ARCHITECTURES[platform], arch)) return null
  const suffix = NODE_ARCHITECTURES[platform][arch]
  if (platform === 'win32') return { packageId: `win-${suffix}-zip`, platformId: `win-${suffix}`, archive: 'zip' }
  if (platform === 'darwin') return { packageId: `osx-${suffix}-tar`, platformId: `darwin-${suffix}`, archive: 'tar.gz' }
  return { packageId: `linux-${suffix}`, platformId: `linux-${suffix}`, archive: 'tar.gz' }
}

function latestNodeLts(releases) {
  return (Array.isArray(releases) ? releases : []).filter(release =>
    typeof release?.version === 'string' && NODE_VERSION.test(release.version) && typeof release.lts === 'string' && release.lts.length > 0
  ).sort((a, b) => b.version.localeCompare(a.version, 'en', { numeric: true }))[0]
}

/** Node's dist index, checksum manifest and archive are all served by nodejs.org. */
async function findNodeBuild({ platform = process.platform, arch = process.arch, request, signal, loadJson = readJson, loadText = readText } = {}) {
  const asset = nodePackage(platform, arch)
  if (!asset) return null
  const options = { request, signal }
  const release = latestNodeLts(await loadJson(`${NODE_DISTRIBUTIONS}/index.json`, options))
  if (!Array.isArray(release?.files) || !release.files.includes(asset.packageId)) return null
  const { archive, platformId } = asset
  const folder = `${NODE_DISTRIBUTIONS}/${release.version}`
  const filename = `node-${release.version}-${platformId}.${archive}`
  const manifest = await loadText(`${folder}/SHASUMS256.txt`, { ...options, maxBytes: 64 * 1024 })
  const hashes = [...(manifest ?? '').matchAll(/^([a-f0-9]{64})[ \t]+\*?(\S+)[ \t]*\r?$/gim)]
    .filter(match => match[2] === filename)
  if (hashes.length !== 1) throw new Error('Node.js가 공개한 배포 파일의 SHA-256을 확인할 수 없습니다.')
  return { tool: 'node', series: 'lts', version: release.version.slice(1), arch, archive,
    url: `${folder}/${filename}`, sha256: hashes[0][1].toLowerCase(),
    distributionFolder: `node-${release.version}-${platformId}`, licenseUrl: NODE_LICENSE_URL }
}

module.exports = { findGradleBuild, findNodeBuild, GRADLE_LICENSE_URL, NODE_LICENSE_URL }
