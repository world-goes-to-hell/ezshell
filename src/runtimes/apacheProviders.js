const { readText } = require('./download.js')

const APACHE_LICENSE_URL = 'https://www.apache.org/licenses/LICENSE-2.0'
const DOWNLOADS = 'https://downloads.apache.org'
const ARCHIVE = 'https://archive.apache.org/dist'
const CHECKSUM_MAX_BYTES = 4096

const APACHE_SERIES = {
  tomcat: ['6', '7', '8.5', '9', '10.1', '11'],
  maven: ['3.9', '3.8', '3.6'],
  ant: ['1.10', '1.9']
}
const PLATFORMS = new Set(['win32', 'darwin', 'linux'])

function validApacheSelection(tool, series) {
  return typeof tool === 'string' && Object.hasOwn(APACHE_SERIES, tool) && APACHE_SERIES[tool].includes(series)
}

function distribution(tool, series) {
  if (tool === 'tomcat') {
    const major = series.split('.')[0]
    return { directory: `/tomcat/tomcat-${major}/`, archived: Number(major) < 9 }
  }
  if (tool === 'maven') return { directory: '/maven/maven-3/', archived: series !== '3.9' }
  return { directory: '/ant/binaries/', archived: series === '1.9' }
}

function recentVersions(listing, tool, series) {
  const versionLink = {
    tomcat: /^v(\d{1,4}\.\d{1,4}\.\d{1,4})\/$/,
    maven: /^(\d{1,4}\.\d{1,4}\.\d{1,4})\/$/,
    ant: /^apache-ant-(\d{1,4}\.\d{1,4}\.\d{1,4})-bin\.(?:zip|tar\.gz)$/
  }[tool]
  const versions = new Set()
  for (const link of (listing ?? '').matchAll(/<a\b[^>]*?\s+href\s*=\s*(["'])([^"']+)\1/gi)) {
    const version = versionLink.exec(link[2])?.[1]
    if (version?.startsWith(`${series}.`)) versions.add(version)
  }
  return [...versions].sort((a, b) => b.localeCompare(a, 'en', { numeric: true })).slice(0, 3)
}

function packagePath(tool, version, archive) {
  if (tool === 'tomcat') return `v${version}/bin/apache-tomcat-${version}.${archive}`
  const filename = `apache-${tool}-${version}-bin.${archive}`
  return tool === 'maven' ? `${version}/binaries/${filename}` : filename
}

async function findApacheBuild(tool, series, { platform = process.platform, request, signal, read = readText } = {}) {
  if (!validApacheSelection(tool, series) || !PLATFORMS.has(platform)) return null
  if (tool === 'tomcat' && series === '6') {
    throw new Error('Tomcat 6 공식 배포본에 SHA-512가 없어 자동으로 받을 수 없습니다.')
  }
  const archive = platform === 'win32' ? 'zip' : 'tar.gz'
  const { directory, archived } = distribution(tool, series)
  const options = { request, signal }
  for (const origin of archived ? [ARCHIVE] : [DOWNLOADS, ARCHIVE]) {
    const base = origin + directory
    const versions = recentVersions(await read(base, options), tool, series)
    for (const version of versions) {
      const artifact = packagePath(tool, version, archive)
      const filename = artifact.split('/').at(-1)
      const url = base + artifact
      const checksum = await read(`${url}.sha512`, { ...options, maxBytes: CHECKSUM_MAX_BYTES })
      if (checksum === null) continue
      const match = /^([a-f0-9]{128})(?:[ \t]+\*?([^\r\n]+))?$/i.exec(checksum.trim())
      if (!match || (match[2] && match[2] !== filename)) {
        throw new Error(`Apache 공식 배포본 ${version}의 SHA-512 형식이 올바르지 않습니다.`)
      }
      return { tool, series, version, archive, url, sha512: match[1].toLowerCase(), licenseUrl: APACHE_LICENSE_URL }
    }
    if (versions.length) throw new Error(`Apache 공식 배포본 ${versions[0]}의 SHA-512를 확인할 수 없습니다.`)
  }
  return null
}

module.exports = { APACHE_LICENSE_URL, APACHE_SERIES, findApacheBuild, validApacheSelection }
