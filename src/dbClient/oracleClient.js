// Oracle's own client libraries (Instant Client 19), for Oracle Database older than 12.1: the
// pure-JavaScript driver does not speak to those, Oracle's libraries do (11.2 and later). Oracle's
// licence lets the libraries be used freely but they are not shipped with the app: the user starts
// the download here after seeing the licence, and it comes straight from Oracle's server.
// What is downloaded is fixed: one address, its size and its SHA-256 (from Oracle's download page).
// A file that differs is thrown away, and nothing is loaded that was not checked.
// Loaded by main.js at runtime (copied to out/main/src), so keep it CommonJS.
const crypto = require('crypto')
const fs = require('fs')
const https = require('https')
const path = require('path')
const { extractZip } = require('./unzip.js')

// Windows x64, "Basic" (all character sets: a Korean database such as KO16MSWIN949 needs it; the
// smaller "Basic Light" reaches only Unicode and Western ones).
const PACKAGE = {
  version: '19.33',
  url: 'https://download.oracle.com/otn_software/nt/instantclient/1933000/instantclient-basic-windows.x64-19.33.0.0.0dbru.zip',
  bytes: 163756019,
  sha256: '2f4df61a9d4be3d2227a7cbb540ec27780e6e4f7b2a274ca7a5c1d396377b3f6',
  folder: 'instantclient_19_33',
  library: 'oci.dll'
}
const LICENSE_URL = 'https://www.oracle.com/downloads/licenses/oracle-free-license.html'
const MAX_REDIRECTS = 3
const DOWNLOAD_TIMEOUT_MS = 60 * 1000
const PROGRESS_EVERY_MS = 300

/** A redirect is followed only to Oracle's own hosts, over https */
function isOracleHost(url) {
  try {
    const parsed = new URL(url)
    return parsed.protocol === 'https:' && (parsed.hostname === 'oracle.com' || parsed.hostname.endsWith('.oracle.com'))
  } catch {
    return false
  }
}

/**
 * @param {object} options
 * @param {string} options.baseDir where the client is kept (a folder of the app's data)
 */
function createOracleClientManager({ baseDir, request = https.get, platform = process.platform, arch = process.arch, pack = PACKAGE }) {
  const clientDir = path.join(baseDir, pack.folder)
  const configDir = path.join(baseDir, 'network')
  let progress = null
  let installing = null

  const isSupported = platform === 'win32' && arch === 'x64'
  const isInstalled = () => fs.existsSync(path.join(clientDir, pack.library))

  /** Settings the libraries read: a tunnel carries no out-of-band data, so a "stop" goes in-band */
  function writeConfig() {
    fs.mkdirSync(configDir, { recursive: true })
    fs.writeFileSync(path.join(configDir, 'sqlnet.ora'), 'DISABLE_OOB=ON\n')
  }

  function download(url, target, onProgress, redirects = 0) {
    return new Promise((resolve, reject) => {
      if (!isOracleHost(url)) return reject(new Error('The download left Oracle\'s server'))
      const req = request(url, { timeout: DOWNLOAD_TIMEOUT_MS }, (res) => {
        const status = res.statusCode || 0
        if (status >= 300 && status < 400 && res.headers.location) {
          res.resume()
          if (redirects >= MAX_REDIRECTS) return reject(new Error('Too many redirects'))
          return resolve(download(new URL(res.headers.location, url).toString(), target, onProgress, redirects + 1))
        }
        if (status !== 200) {
          res.resume()
          return reject(Object.assign(new Error(`Oracle 서버가 파일을 주지 않았습니다 (HTTP ${status}).`), { code: 'EZ_DOWNLOAD' }))
        }
        const hash = crypto.createHash('sha256')
        const file = fs.createWriteStream(target)
        let received = 0
        let reportedAt = 0
        res.on('data', (chunk) => {
          received += chunk.length
          hash.update(chunk)
          // More than the file is known to be: not the file
          if (received > pack.bytes) req.destroy(new Error('The download is larger than expected'))
          const now = Date.now()
          if (now - reportedAt >= PROGRESS_EVERY_MS) {
            reportedAt = now
            onProgress({ received, total: pack.bytes })
          }
        })
        res.pipe(file)
        file.on('error', reject)
        res.on('error', reject)
        file.on('finish', () => resolve({ received, sha256: hash.digest('hex') }))
      })
      req.on('timeout', () => req.destroy(new Error('Oracle 서버가 응답하지 않습니다.')))
      req.on('error', reject)
    })
  }

  async function run(onProgress) {
    if (!isSupported) throw new Error('이 구성 요소는 Windows(x64)에서만 설치할 수 있습니다.')
    fs.mkdirSync(baseDir, { recursive: true })
    const zipPath = path.join(baseDir, 'download.part')
    const unpackDir = path.join(baseDir, `unpack-${crypto.randomBytes(4).toString('hex')}`)
    const report = (state) => {
      progress = state
      onProgress(state)
    }
    try {
      report({ step: 'download', received: 0, total: pack.bytes })
      const got = await download(pack.url, zipPath, (state) => report({ step: 'download', ...state }))
      // Exactly the file Oracle published, or nothing
      if (got.received !== pack.bytes || got.sha256 !== pack.sha256) {
        throw Object.assign(new Error('내려받은 파일이 Oracle 이 공개한 것과 다릅니다. 설치하지 않았습니다.'), { code: 'EZ_CHECKSUM' })
      }
      report({ step: 'unpack', received: pack.bytes, total: pack.bytes })
      await extractZip(zipPath, unpackDir)
      if (!fs.existsSync(path.join(unpackDir, pack.folder, pack.library))) throw new Error('압축 파일 안에 필요한 라이브러리가 없습니다.')
      fs.rmSync(clientDir, { recursive: true, force: true })
      fs.renameSync(path.join(unpackDir, pack.folder), clientDir)
      writeConfig()
    } finally {
      fs.rmSync(zipPath, { force: true })
      fs.rmSync(unpackDir, { recursive: true, force: true })
      progress = null
    }
  }

  return {
    status: () => ({ isSupported, isInstalled: isInstalled(), version: pack.version, bytes: pack.bytes, licenseUrl: LICENSE_URL, progress }),
    /** Where the driver loads the libraries from, with their settings; null when they are not installed */
    location() {
      if (!isSupported || !isInstalled()) return null
      if (!fs.existsSync(path.join(configDir, 'sqlnet.ora'))) writeConfig()
      return { libDir: clientDir, configDir }
    },
    /** Downloads, checks and unpacks; one at a time (a second call waits for the first) */
    install(onProgress = () => {}) {
      if (!installing) installing = run(onProgress).finally(() => { installing = null })
      return installing
    },
    /** Removes the libraries. Fails while they are loaded (the files are in use until the app restarts). */
    remove() {
      fs.rmSync(clientDir, { recursive: true, force: true })
    }
  }
}

module.exports = { createOracleClientManager, isOracleHost, PACKAGE, LICENSE_URL }
