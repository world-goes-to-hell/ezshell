const fs = require('node:fs')
const https = require('node:https')
const { createHash } = require('node:crypto')
const { addAbortSignal, Transform } = require('node:stream')
const { pipeline } = require('node:stream/promises')

const HOSTS = new Set(['api.adoptium.net', 'github.com', 'objects.githubusercontent.com', 'release-assets.githubusercontent.com',
  'api.azul.com', 'cdn.azul.com', 'api.github.com', 'cache-redirector.jetbrains.com', 'd2xrhe97vsfxuc.cloudfront.net',
  'downloads.apache.org', 'archive.apache.org'])
const MAX_REDIRECTS = 5
const MAX_JSON_BYTES = 2 * 1024 * 1024
const MAX_ARCHIVE_BYTES = 768 * 1024 * 1024
const METADATA_TIMEOUT_MS = 30_000
const ARCHIVE_TIMEOUT_MS = 30 * 60_000
const SHA256 = /^[0-9a-f]{64}$/i
const SHA512 = /^[0-9a-f]{128}$/i

function approvedUrl(value) {
  let url
  try { url = new URL(value) } catch { return null }
  return url.protocol === 'https:' && !url.port && !url.username && !url.password && HOSTS.has(url.hostname) ? url : null
}

async function withDeadline(duration, cancellation, message, run) {
  const deadline = new AbortController()
  const timer = setTimeout(() => deadline.abort(new Error(message)), duration)
  timer.unref?.()
  const signal = cancellation ? AbortSignal.any([deadline.signal, cancellation]) : deadline.signal
  try { return await run(signal) }
  catch (error) { signal.throwIfAborted(); throw error }
  finally { clearTimeout(timer) }
}

/** Validate the URL before every request, including requests reached by a redirect. */
async function openResponse(value, { request = https.get, signal } = {}) {
  for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects++) {
    signal?.throwIfAborted()
    const url = approvedUrl(value)
    if (!url) throw new Error('허용되지 않은 다운로드 주소입니다.')
    const response = await new Promise((resolve, reject) => {
      const req = request(url, { signal, timeout: 30_000, headers: { 'User-Agent': 'ezShell JDK runtimes' } }, resolve)
      req.on('timeout', () => req.destroy(new Error('다운로드 서버에서 응답이 없습니다.')))
      req.on('error', reject)
    })
    if (![301, 302, 303, 307, 308].includes(response.statusCode)) return signal ? addAbortSignal(signal, response) : response
    response.destroy()
    const location = response.headers.location
    if (typeof location !== 'string' || !location) throw new Error('다운로드 서버의 이동 주소가 없습니다.')
    value = new URL(location, url)
  }
  throw new Error('다운로드 서버의 이동 주소가 너무 많습니다.')
}

function readJson(url, options = {}) {
  return readText(url, options).then(body => body === null ? null : JSON.parse(body))
}

function readText(url, options = {}) {
  return withDeadline(METADATA_TIMEOUT_MS, options.signal, '릴리스 정보 응답 시간이 30초를 넘겼습니다.',
    signal => readTextResponse(url, { ...options, signal }))
}

async function readTextResponse(url, options) {
  const response = await openResponse(url, options)
  if (response.statusCode !== 200) {
    response.destroy()
    if (response.statusCode === 404) return null
    throw new Error(`릴리스 정보를 받지 못했습니다 (HTTP ${response.statusCode}).`)
  }
  const chunks = []
  let size = 0
  for await (const chunk of response) {
    size += chunk.length
    if (size > (options.maxBytes ?? MAX_JSON_BYTES)) throw new Error('릴리스 정보의 크기가 너무 큽니다.')
    chunks.push(chunk)
  }
  return Buffer.concat(chunks).toString('utf8')
}

function downloadArchive(build, target, options = {}) {
  return withDeadline(ARCHIVE_TIMEOUT_MS, options.signal, '파일 다운로드 시간이 30분을 넘겼습니다.',
    signal => receiveArchive(build, target, { ...options, signal }))
}

async function receiveArchive(build, target, { request, signal, onProgress }) {
  const usesSha512 = build.sha512 !== undefined
  const expectedHash = usesSha512 ? build.sha512 : build.sha256
  const hashName = usesSha512 ? 'SHA-512' : 'SHA-256'
  if (!(usesSha512 ? SHA512 : SHA256).test(expectedHash)) throw new Error(`다운로드의 ${hashName} 값이 없습니다.`)
  const response = await openResponse(build.url, { request, signal })
  if (response.statusCode !== 200) {
    response.destroy()
    throw new Error(`다운로드 파일을 받지 못했습니다 (HTTP ${response.statusCode}).`)
  }
  const expected = Number(response.headers['content-length']) || null
  const total = build.sizeBytes ?? expected
  if ((total && total > MAX_ARCHIVE_BYTES) || (build.sizeBytes && expected && expected !== build.sizeBytes)) {
    response.destroy()
    throw new Error('다운로드 파일의 크기가 공급자가 공개한 값과 다릅니다.')
  }
  const hash = createHash(usesSha512 ? 'sha512' : 'sha256')
  let received = 0
  let lastReported = 0
  const meter = new Transform({
    transform(chunk, _encoding, next) {
      received += chunk.length
      if (received > (total ?? MAX_ARCHIVE_BYTES)) return next(new Error('다운로드 파일의 크기가 너무 큽니다.'))
      hash.update(chunk)
      if (Date.now() - lastReported >= 250) {
        lastReported = Date.now()
        onProgress?.(received, total)
      }
      next(null, chunk)
    }
  })
  await pipeline(response, meter, fs.createWriteStream(target, { flags: 'wx' }), { signal })
  onProgress?.(received, total)
  if ((total && received !== total) || hash.digest('hex') !== expectedHash.toLowerCase()) {
    throw new Error(`다운로드의 ${hashName} 또는 크기가 일치하지 않습니다.`)
  }
  return received
}

module.exports = { approvedUrl, readJson, readText, downloadArchive, SHA256 }
