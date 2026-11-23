const fs = require('node:fs/promises')
const path = require('node:path')
const { isUuid } = require('../agentHistory/common.js')

/** Claude Code writes sessions/<pid>.json for running sessions, independently of MCP and usage. */
async function readClaudeSessions(root) {
  const directory = path.join(root, 'sessions')
  const files = await fs.readdir(directory, { withFileTypes: true }).catch(() => [])
  const sessions = []
  for (const file of files) {
    if (!file.isFile() || !/^[1-9]\d*\.json$/.test(file.name)) continue
    try {
      const { pid, kind, entrypoint, sessionId, cwd, startedAt } = JSON.parse(await fs.readFile(path.join(directory, file.name), 'utf8'))
      if (Number.isSafeInteger(pid) && file.name === pid + '.json' && kind === 'interactive' && entrypoint === 'cli'
        && isUuid(sessionId) && typeof cwd === 'string' && path.isAbsolute(cwd) && !cwd.includes('\0')
        && Number.isFinite(startedAt) && startedAt > 0) {
        sessions.push({ pid, sessionId: sessionId.toLowerCase(), cwd, startedAt })
      }
    } catch { /* Claude may be rewriting or removing the file. */ }
  }
  return sessions
}

module.exports = { readClaudeSessions }
