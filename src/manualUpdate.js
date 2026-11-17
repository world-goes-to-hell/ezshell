// Update check for builds that cannot update themselves (the unsigned macOS build: Squirrel.Mac
// only applies an update whose code signature matches the running app, and this build has none).
// It asks GitHub for the latest release and, when that is newer AND carries a download for this
// machine, the app points the user at the release page. Nothing is downloaded or run by the app.

const https = require('https')

const REPO = 'world-goes-to-hell/ezshell'
const LATEST_RELEASE_URL = `https://api.github.com/repos/${REPO}/releases/latest`
const MAX_RESPONSE_BYTES = 1024 * 1024
const REQUEST_TIMEOUT_MS = 10000
const VERSION = /^v?(\d{1,5})\.(\d{1,5})\.(\d{1,5})$/

function parseVersion(text) {
  const match = typeof text === 'string' ? VERSION.exec(text.trim()) : null
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null
}

function isNewer(candidate, current) {
  for (let i = 0; i < 3; i += 1) {
    if (candidate[i] !== current[i]) return candidate[i] > current[i]
  }
  return false
}

/** The page the user is sent to. Built here from a checked version, never taken from the response. */
function releasePageUrl(version) {
  return `https://github.com/${REPO}/releases/tag/v${version}`
}

/**
 * @param {unknown} release  body of GitHub's "latest release" answer
 * @returns {{ status: 'available', version: string, url: string } | { status: 'not-available', version: string }}
 *   'available' only when the release is newer and has the .dmg for this architecture: the macOS
 *   files are attached some minutes after the release appears, and a page without them helps nobody.
 */
function readRelease(release, { currentVersion, arch }) {
  const current = parseVersion(currentVersion)
  if (!current) throw new Error('현재 버전을 읽지 못했습니다')
  if (!release || typeof release !== 'object') throw new Error('릴리스 정보를 읽지 못했습니다')
  const latest = parseVersion(release.tag_name)
  if (!latest) throw new Error('릴리스 정보를 읽지 못했습니다')
  const version = latest.join('.')
  const upToDate = { status: 'not-available', version: current.join('.') }
  if (release.draft === true || release.prerelease === true) return upToDate
  if (!isNewer(latest, current)) return upToDate
  const wanted = `ezShell-${version}-${arch}.dmg`
  const assets = Array.isArray(release.assets) ? release.assets : []
  if (!assets.some(asset => asset && asset.name === wanted)) return upToDate
  return { status: 'available', version, url: releasePageUrl(version) }
}

function fetchLatestRelease({ request = https.get } = {}) {
  return new Promise((resolve, reject) => {
    const req = request(LATEST_RELEASE_URL, {
      headers: { 'User-Agent': 'ezShell', Accept: 'application/vnd.github+json' },
      timeout: REQUEST_TIMEOUT_MS
    }, (res) => {
      if (res.statusCode !== 200) {
        res.resume()
        reject(new Error(`업데이트 서버가 응답하지 않았습니다 (${res.statusCode})`))
        return
      }
      const chunks = []
      let size = 0
      res.on('data', (chunk) => {
        size += chunk.length
        if (size > MAX_RESPONSE_BYTES) {
          req.destroy(new Error('릴리스 정보가 너무 큽니다'))
          return
        }
        chunks.push(chunk)
      })
      res.on('end', () => {
        try {
          resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')))
        } catch {
          reject(new Error('릴리스 정보를 읽지 못했습니다'))
        }
      })
      res.on('error', reject)
    })
    req.on('timeout', () => req.destroy(new Error('업데이트 서버 응답이 늦습니다')))
    req.on('error', reject)
  })
}

async function checkLatest({ currentVersion, arch = process.arch, request } = {}) {
  return readRelease(await fetchLatestRelease({ request }), { currentVersion, arch })
}

module.exports = { checkLatest, readRelease, releasePageUrl, parseVersion }
