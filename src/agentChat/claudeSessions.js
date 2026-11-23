const fs = require('node:fs/promises')
const path = require('node:path')
const { isUuid } = require('../agentHistory/common.js')

const UNIX_EPOCH_FILETIME = 116444736000000000

function filetimeMilliseconds(value) {
  if (typeof value !== 'number' && (typeof value !== 'string' || !/^\d{1,20}$/.test(value))) return null
  const filetime = Number(value)
  return Number.isInteger(filetime) && filetime > UNIX_EPOCH_FILETIME ? (filetime - UNIX_EPOCH_FILETIME) / 10000 : null
}

/** Claude Code writes sessions/<pid>.json for running sessions, independently of MCP and usage. */
async function readClaudeSessions(root) {
  const directory = path.join(root, 'sessions')
  const files = await fs.readdir(directory, { withFileTypes: true }).catch(() => [])
  const sessions = []
  for (const file of files) {
    if (!file.isFile() || !/^[1-9]\d*\.json$/.test(file.name)) continue
    try {
      const { pid, kind, entrypoint, sessionId, cwd, startedAt, procStart } = JSON.parse(await fs.readFile(path.join(directory, file.name), 'utf8'))
      const processStartedAt = filetimeMilliseconds(procStart)
      if (Number.isSafeInteger(pid) && file.name === pid + '.json' && kind === 'interactive' && entrypoint === 'cli'
        && isUuid(sessionId) && typeof cwd === 'string' && path.isAbsolute(cwd) && !cwd.includes('\0')
        && Number.isFinite(startedAt) && startedAt > 0 && (procStart === undefined || processStartedAt !== null)) {
        sessions.push({ pid, sessionId: sessionId.toLowerCase(), cwd, startedAt,
          ...(processStartedAt === null ? {} : { processStartedAt }) })
      }
    } catch { /* Claude may be rewriting or removing the file. */ }
  }
  return sessions
}

module.exports = { readClaudeSessions }
