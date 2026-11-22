// Search names and paths inside a working directory that roots.js has already resolved.
const fs = require('fs')
const path = require('path')
const { sameOrInside } = require('./roots.js')

const RESULT_LIMIT = 200
const ENTRY_LIMIT = 50000
const TIME_LIMIT_MS = 4000
const normalized = value => value.normalize('NFC').toLowerCase().replace(/\\/g, '/')
const pathKey = value => process.platform === 'win32' ? value.toLowerCase() : value

async function searchDirectory(root, query, signal) {
  const terms = normalized(query).split(/\s+/)
  const pending = ['']
  const matches = []
  const deadline = Date.now() + TIME_LIMIT_MS
  let scanned = 0
  let incomplete = false
  const results = truncated => ({
    entries: matches.sort((a, b) => a.path.localeCompare(b.path)),
    truncated
  })

  for (let index = 0; index < pending.length; index++) {
    signal.throwIfAborted()
    if (Date.now() >= deadline) return results(true)
    const relative = pending[index]
    const target = path.join(root, relative)
    try {
      const directory = relative ? await fs.promises.realpath(target) : root
      // A directory may have been replaced by a link since its parent was listed.
      if (!sameOrInside(pathKey(root), pathKey(directory)) || pathKey(directory) !== pathKey(target)) {
        incomplete = true
        continue
      }
      const content = await fs.promises.opendir(directory)
      for await (const entry of content) {
        signal.throwIfAborted()
        if (++scanned > ENTRY_LIMIT || Date.now() >= deadline) return results(true)
        if (entry.name.toLowerCase() === '.git') continue

        const entryPath = relative ? `${relative}/${entry.name}` : entry.name
        const kind = entry.isSymbolicLink() ? 'link' : entry.isDirectory() ? 'directory' : entry.isFile() ? 'file' : null
        if (kind === 'directory') pending.push(entryPath)
        if (!kind) continue

        const searchable = normalized(entryPath)
        if (terms.every(term => searchable.includes(term))) {
          if (matches.length === RESULT_LIMIT) return results(true)
          matches.push({ name: entry.name, kind, path: entryPath })
        }
      }
    } catch (error) {
      if (!relative || signal.aborted) throw error
      incomplete = true
    }
  }
  return results(incomplete)
}

module.exports = { searchDirectory }
