// Append-only JSON-lines log of every MCP request. Writing must succeed before a
// command runs; the caller refuses to execute when append() throws.
const fs = require('fs')

const DEFAULT_MAX_BYTES = 5 * 1024 * 1024
const DEFAULT_LIMIT = 200

function createAuditLog({ filePath, maxBytes = DEFAULT_MAX_BYTES, fileSystem = fs, now = () => new Date() }) {
  const rotatedPath = `${filePath}.1`

  function rotateIfNeeded(incomingBytes) {
    let size
    try {
      size = fileSystem.statSync(filePath).size
    } catch {
      return
    }
    if (size + incomingBytes > maxBytes) fileSystem.renameSync(filePath, rotatedPath)
  }

  function append(entry) {
    const line = `${JSON.stringify({ ...entry, time: now().toISOString() })}\n`
    rotateIfNeeded(Buffer.byteLength(line))
    fileSystem.appendFileSync(filePath, line, 'utf8')
  }

  function readEntries(file) {
    let text
    try {
      text = fileSystem.readFileSync(file, 'utf8')
    } catch {
      return []
    }
    return text.split('\n').filter(Boolean).flatMap(line => {
      try {
        return [JSON.parse(line)]
      } catch {
        return []
      }
    })
  }

  function readRecent(limit = DEFAULT_LIMIT) {
    if (limit <= 0) return []
    const entries = [...readEntries(rotatedPath), ...readEntries(filePath)]
    return entries.filter(entry => entry.phase === 'end').slice(-limit).reverse()
  }

  return { append, readRecent }
}

module.exports = { createAuditLog }
