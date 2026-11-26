const { readJson, readText, SHA256 } = require('./download.js')

const GITHUB_API = 'https://api.github.com/repos'
const JBR_API = `${GITHUB_API}/JetBrains/JetBrainsRuntime`
const JBR_DOWNLOAD = 'https://cache-redirector.jetbrains.com/intellij-jbr'
const AGENT_REPO = 'HotswapProjects/HotswapAgent'
const JBR_TAG = /^jbr-release-((17|21)\.[0-9.]+)b(\d+\.\d+)$/
const JBR_OS = { win32: 'windows', darwin: 'osx', linux: 'linux' }
const JBR_ARCH = { x64: 'x64', arm64: 'aarch64' }
const AGENT_VERSION = /^2\.\d{1,5}\.\d{1,5}$/
const MAX_AGENT_BYTES = 16 * 1024 * 1024
const AGENT_LICENSE_URL = 'https://github.com/HotswapProjects/HotswapAgent/blob/master/LICENSE'
const JBR_LICENSE_URL = 'https://openjdk.org/legal/gplv2+ce.html'

function jbrTags(data, feature) {
  return (Array.isArray(data) ? data : []).flatMap(value => {
    const tag = typeof value?.ref === 'string' && value.ref.startsWith('refs/tags/') ? value.ref.slice('refs/tags/'.length) : ''
    const fields = JBR_TAG.exec(tag)
    return fields && Number(fields[2]) === feature ? [tag] : []
  }).sort((a, b) => b.localeCompare(a, 'en', { numeric: true })).slice(0, 5)
}

function jbrPackage(release, tag, { platform, arch }) {
  const fields = JBR_TAG.exec(tag)
  if (!fields || release?.tag_name !== tag || release.draft !== false || release.prerelease !== false || typeof release.body !== 'string'
    || !Object.hasOwn(JBR_OS, platform) || !Object.hasOwn(JBR_ARCH, arch)) return null
  const [, version, feature, build] = fields
  const archive = platform === 'win32' ? 'zip' : 'tar.gz'
  const filename = `jbrsdk-${version}-${JBR_OS[platform]}-${JBR_ARCH[arch]}-b${build}.${archive}`
  const url = `${JBR_DOWNLOAD}/${filename}`
  const checksumUrl = `${url}.checksum`
  // Require both published links from the official release, including the SDK flavour (it contains javac).
  if (!release.body.includes(`](${url})`) || !release.body.includes(`](${checksumUrl})`)) return null
  return { vendor: 'jbr', feature: Number(feature), arch, version: `${version}+${build}`, archive, filename, url, checksumUrl, licenseUrl: JBR_LICENSE_URL }
}

async function findJbrBuild(feature, { platform, arch, request, signal }) {
  if ((feature !== 17 && feature !== 21) || !Object.hasOwn(JBR_OS, platform) || !Object.hasOwn(JBR_ARCH, arch)) return null
  const options = { request, signal }
  const refs = await readJson(`${JBR_API}/git/matching-refs/tags/jbr-release-${feature}.`, options)
  for (const tag of jbrTags(refs, feature)) {
    const release = await readJson(`${JBR_API}/releases/tags/${tag}`, options)
    const archive = jbrPackage(release, tag, { platform, arch })
    if (!archive) continue
    const { filename, checksumUrl, ...build } = archive
    const checksum = await readText(checksumUrl, { ...options, maxBytes: 4096 })
    const fields = /^([0-9a-f]{128})(?:[ \t]+\*?([^\r\n]+))?$/i.exec(checksum?.trim() ?? '')
    if (!fields || (fields[2] && fields[2] !== filename)) throw new Error('JetBrains Runtime에서 공개한 SHA-512를 확인할 수 없습니다.')
    return { ...build, sha512: fields[1] }
  }
  return null
}

function agentBuild(releases) {
  for (const release of Array.isArray(releases) ? releases : []) {
    const version = typeof release?.tag_name === 'string' ? release.tag_name.replace(/^RELEASE-/, '') : ''
    if (!AGENT_VERSION.test(version) || release.draft !== false || release.prerelease !== false) continue
    const filename = `hotswap-agent-${version}.jar`
    const asset = Array.isArray(release.assets) && release.assets.find(item => item?.name === filename && item.state === 'uploaded')
    const url = `https://github.com/${AGENT_REPO}/releases/download/${release.tag_name}/${filename}`
    const sha256 = typeof asset?.digest === 'string' && asset.digest.startsWith('sha256:') ? asset.digest.slice(7) : ''
    if (asset?.browser_download_url !== url || !SHA256.test(sha256) || !Number.isSafeInteger(asset.size) || asset.size <= 0 || asset.size > MAX_AGENT_BYTES) continue
    return { version, url, sha256, sizeBytes: asset.size, licenseUrl: AGENT_LICENSE_URL }
  }
  return null
}

async function findHotswapAgent(options) {
  return agentBuild(await readJson(`${GITHUB_API}/${AGENT_REPO}/releases?per_page=12`, options))
}

module.exports = { findJbrBuild, findHotswapAgent, AGENT_VERSION, MAX_AGENT_BYTES, AGENT_LICENSE_URL, JBR_LICENSE_URL }
