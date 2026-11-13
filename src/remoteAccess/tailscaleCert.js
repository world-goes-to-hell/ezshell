// HTTPS for remote access, with the certificate Tailscale issues for this PC's tailnet name
// (<pc>.<tailnet>.ts.net, `tailscale cert`). Only a page served over HTTPS may receive push
// notifications. The tailnet's admin has to switch HTTPS certificates on once; until then (or when
// the Tailscale program cannot be run) remote access stays on plain HTTP, without notifications.
// Loaded by main.js at runtime (copied to out/main/src), so keep it CommonJS.
const crypto = require('crypto')
const fs = require('fs')
const path = require('path')
const { execFile } = require('child_process')

const STATUS_TIMEOUT_MS = 10 * 1000
/** Issuing a certificate asks Let's Encrypt and can take a while the first time */
const CERT_TIMEOUT_MS = 90 * 1000
/** A certificate is asked for again when it has less than this left (Tailscale renews it itself) */
const RENEW_BEFORE_MS = 14 * 24 * 60 * 60 * 1000
// Every label starts with a letter or digit: a name is never taken for an option of the program
const TAILNET_NAME = /^[a-z0-9][a-z0-9-]*(\.[a-z0-9][a-z0-9-]*)*\.ts\.net$/i

// By its full path. On Windows only there: a bare name would also be looked up in the current folder
const programs = () => (process.platform === 'win32'
  ? [path.join(process.env.ProgramFiles || 'C:\\Program Files', 'Tailscale', 'tailscale.exe')]
  : ['/usr/bin/tailscale', '/usr/local/bin/tailscale', '/Applications/Tailscale.app/Contents/MacOS/Tailscale', 'tailscale'])

/** Runs the Tailscale program with `args`; resolves with its output, rejects when none could be run or it failed */
function runTailscale(args, { timeout }) {
  return new Promise((resolve, reject) => {
    const candidates = programs()
    const attempt = (index) => {
      execFile(candidates[index], args, { timeout, windowsHide: true, maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => {
        if (err && err.code === 'ENOENT' && index + 1 < candidates.length) return attempt(index + 1)
        if (err) return reject(new Error(String(stderr || err.message).trim().slice(0, 300)))
        resolve(String(stdout))
      })
    }
    attempt(0)
  })
}

/**
 * This PC's tailnet name and whether a certificate can be had for it.
 * @returns {Promise<{ name: string | null, canCertify: boolean }>}
 */
async function tailnetName({ run = runTailscale } = {}) {
  const status = JSON.parse(await run(['status', '--json'], { timeout: STATUS_TIMEOUT_MS }))
  const name = String(status?.Self?.DNSName ?? '').replace(/\.$/, '').toLowerCase()
  if (!TAILNET_NAME.test(name)) return { name: null, canCertify: false }
  const domains = Array.isArray(status.CertDomains) ? status.CertDomains.map((domain) => String(domain).toLowerCase()) : []
  return { name, canCertify: domains.includes(name) }
}

/** Whether `cert` (PEM) is for `name` and still good for `leastLeftMs` */
function isGoodFor(cert, name, now, leastLeftMs) {
  try {
    const parsed = new crypto.X509Certificate(cert)
    return parsed.checkHost(name) !== undefined && new Date(parsed.validTo).getTime() - now > leastLeftMs
  } catch {
    return false
  }
}

/**
 * The certificate and key for `name`, from `dir`: asked from Tailscale when there is none or it
 * runs out soon. A renewal that fails keeps the certificate at hand while it is still valid.
 * @returns {Promise<{ cert: string, key: string }>}
 */
async function ensureCertificate({ dir, name, run = runTailscale, now = Date.now(), fileSystem = fs }) {
  if (!TAILNET_NAME.test(name)) throw new Error('Not a tailnet name')
  const certFile = path.join(dir, 'remote-access-cert.pem')
  const keyFile = path.join(dir, 'remote-access-key.pem')
  const read = () => {
    try {
      return { cert: fileSystem.readFileSync(certFile, 'utf-8'), key: fileSystem.readFileSync(keyFile, 'utf-8') }
    } catch {
      return null
    }
  }
  const atHand = read()
  if (atHand && isGoodFor(atHand.cert, name, now, RENEW_BEFORE_MS)) return atHand
  try {
    await run(['cert', '--cert-file', certFile, '--key-file', keyFile, '--', name], { timeout: CERT_TIMEOUT_MS })
  } catch (err) {
    if (atHand && isGoodFor(atHand.cert, name, now, 0)) return atHand
    throw err
  }
  const issued = read()
  if (!issued || !isGoodFor(issued.cert, name, now, 0)) throw new Error('Tailscale did not give a usable certificate')
  return issued
}

/** Removes the certificate and its key from `dir` (remote access was switched off; Tailscale hands them out again) */
function removeCertificate(dir, fileSystem = fs) {
  for (const name of ['remote-access-cert.pem', 'remote-access-key.pem']) {
    try {
      fileSystem.unlinkSync(path.join(dir, name))
    } catch {
      // Not there
    }
  }
}

module.exports = { tailnetName, ensureCertificate, removeCertificate, isGoodFor, TAILNET_NAME }
