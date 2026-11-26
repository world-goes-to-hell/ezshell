const fs = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const { isLocalFilePath } = require('../localKeyPath.js')

const PRESET = /^[a-f\d]{8}-(?:[a-f\d]{4}-){3}[a-f\d]{12}$/i
const WORKTREE = /^[a-f\d]{64}$/i
const ACTIVE_RUN = /^run-([1-9]\d{0,9})-[a-z\d]{6}$/i
const JAVAC = /^ezshell-javac-([1-9]\d{0,9})-[a-z\d]{6}$/i
const ECLIPSE = /^\.build-([1-9]\d{0,9})-[a-z\d]{6}$/i
const SETTINGS = /^\.run-[a-f\d]{8}-(?:[a-f\d]{4}-){3}[a-f\d]{12}-([1-9]\d{0,9})-[a-z\d]{6}$/i
const pending = new Set()

function trackRunCleanup(promise) {
  pending.add(promise)
  const settle = () => pending.delete(promise)
  void promise.then(settle, settle)
  return promise
}

function waitRunCleanup() {
  return pending.size ? Promise.allSettled([...pending]) : null
}

async function realDirectory(directory) {
  if (!isLocalFilePath(directory) || !(await fs.lstat(directory)).isDirectory()) return null
  return fs.realpath(directory)
}

const same = (a, b) => b !== null && path.relative(a, b) === ''

function ownerExited(pid) {
  if (pid === process.pid || pid > 2147483647) return false
  try { process.kill(pid, 0); return false }
  catch (error) { return error.code === 'ESRCH' }
}

async function sweep(root, levels, pattern) {
  const entries = await fs.readdir(root, { withFileTypes: true }).catch(() => [])
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const folder = path.join(root, entry.name)
    try {
      if (levels.length) {
        if (levels[0].test(entry.name) && same(folder, await realDirectory(folder))) await sweep(folder, levels.slice(1), pattern)
      } else {
        const match = pattern.exec(entry.name)
        if (match && ownerExited(Number(match[1])) && same(folder, await realDirectory(folder))) {
          await fs.rm(folder, { recursive: true, force: true, maxRetries: 1, retryDelay: 60 })
        }
      }
    } catch { /* Locked or moved directories can be checked at the next start. */ }
  }
}

async function reapRunScratch(userData, tempRoot = os.tmpdir()) {
  const [profile, temp] = await Promise.all([userData, tempRoot].map(folder => realDirectory(folder).catch(() => null)))
  const jobs = temp ? [sweep(temp, [], JAVAC)] : []
  if (profile) {
    const runtime = path.join(profile, 'runtimes')
    if (same(runtime, await realDirectory(runtime).catch(() => null))) {
      const layouts = [
        ['maven-pinned', [PRESET], ACTIVE_RUN], ['tomcat-base', [PRESET], ACTIVE_RUN],
        ['maven-settings', [], SETTINGS], ['tomcat-classes', [PRESET, WORKTREE], ECLIPSE]
      ]
      for (const [name, levels, pattern] of layouts) {
        const folder = path.join(runtime, name)
        if (same(folder, await realDirectory(folder).catch(() => null))) jobs.push(sweep(folder, levels, pattern))
      }
    }
  }
  await Promise.allSettled(jobs)
}

module.exports = { reapRunScratch, trackRunCleanup, waitRunCleanup }
