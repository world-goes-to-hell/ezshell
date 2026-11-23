const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const UUID = /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i
const TRANSCRIPTS = ['transcript_full.jsonl', 'transcript.jsonl']
const READ_ONLY = fs.constants.O_RDONLY | (process.platform === 'win32' ? 0 : (fs.constants.O_NOFOLLOW ?? 0))
const localAbsolute = value => typeof value === 'string' && (process.platform === 'win32'
  ? /^[a-z]:[\\/]/i.test(value) : path.isAbsolute(value) && !value.startsWith('//'))
const pathKey = value => process.platform === 'win32' ? value.toLowerCase() : value
const fileIdentity = stat => `${stat.dev}:${stat.ino}:${stat.birthtimeMs}`

function antigravityBrainRoot() {
  const home = process.platform === 'win32' ? process.env.USERPROFILE : os.homedir()
  return localAbsolute(home) ? path.join(home, '.gemini', 'antigravity-cli', 'brain') : null
}

function antigravitySessionId(value) {
  return typeof value === 'string' && UUID.test(value) ? value.toLowerCase() : null
}

async function localTranscriptStat(file) {
  const root = path.parse(file).root
  const parts = file.slice(root.length).split(path.sep)
  let current = root
  for (const part of parts.slice(0, -1)) {
    current = path.join(current, part)
    // isDirectory() on lstat also excludes junctions and symbolic links.
    if (!(await fs.promises.lstat(current)).isDirectory()) return null
  }
  const stat = await fs.promises.lstat(file)
  if (!stat.isFile() || stat.nlink !== 1) return null
  const real = await fs.promises.realpath(file)
  return localAbsolute(real) && pathKey(real) === pathKey(file) ? stat : null
}

/** Open only a transcript under the local agy brain. The caller closes the returned handle. */
async function openAntigravityTranscript(root, sessionId, expectedFile) {
  const id = antigravitySessionId(sessionId)
  if (!id || !localAbsolute(root)) return null
  const logs = path.join(root, id, '.system_generated', 'logs')
  for (const name of TRANSCRIPTS) {
    const file = path.join(logs, name)
    if (expectedFile && file !== expectedFile) continue
    let handle
    try {
      const selected = await localTranscriptStat(file)
      if (!selected) continue
      handle = await fs.promises.open(file, READ_ONLY)
      const stat = await handle.stat()
      const current = await localTranscriptStat(file)
      if (current && stat.isFile() && fileIdentity(stat) === fileIdentity(selected) && fileIdentity(stat) === fileIdentity(current)) {
        return { file, handle, stat, identity: fileIdentity(stat) }
      }
    } catch { /* Missing or unsafe. The compact transcript can still be available. */ }
    await handle?.close()
  }
  return null
}

module.exports = { antigravityBrainRoot, antigravitySessionId, openAntigravityTranscript }
