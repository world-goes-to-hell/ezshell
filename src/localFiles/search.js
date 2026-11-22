// Search names and paths inside a working directory that roots.js has already resolved.
const fs = require('fs')
const path = require('path')
const { sameOrInside } = require('./roots.js')

const RESULT_LIMIT = 200
const ENTRY_LIMIT = 50000
const TIME_LIMIT_MS = 4000
const CACHE_MS = 10000
const UPDATE_INTERVAL = 128
const normalized = value => value.normalize('NFC').toLowerCase().replace(/\\/g, '/')
const pathKey = value => process.platform === 'win32' ? value.toLowerCase() : value

async function scanDirectory(root, entries, signal, publish) {
  const pending = ['']
  const deadline = Date.now() + TIME_LIMIT_MS
  let scanned = 0
  let incomplete = false

  for (let index = 0; index < pending.length; index++) {
    signal.throwIfAborted()
    if (Date.now() >= deadline) return true
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
        if (++scanned > ENTRY_LIMIT || Date.now() >= deadline) return true
        if (entry.name.toLowerCase() === '.git') continue

        const entryPath = relative ? `${relative}/${entry.name}` : entry.name
        const kind = entry.isSymbolicLink() ? 'link' : entry.isDirectory() ? 'directory' : entry.isFile() ? 'file' : null
        if (kind === 'directory') pending.push(entryPath)
        if (!kind) continue

        entries.push({ name: entry.name, kind, path: entryPath, searchable: normalized(entryPath) })
        if (entries.length % UPDATE_INTERVAL === 0) publish()
      }
    } catch (error) {
      if (!relative || signal.aborted) throw error
      incomplete = true
    }
  }
  return incomplete
}

function startIndex(root, now) {
  const controller = new AbortController()
  const index = { root, controller, entries: [], truncated: false, error: null, finishedAt: null, changed: null }
  let notify
  const waitForChange = () => { index.changed = new Promise(resolve => { notify = resolve }) }
  waitForChange()
  const publish = () => {
    const previous = notify
    waitForChange()
    previous()
  }
  void scanDirectory(root, index.entries, controller.signal, publish).then(
    truncated => { index.truncated = truncated },
    error => { index.error = error }
  ).finally(() => {
    index.finishedAt = now()
    notify()
  })
  return index
}

/** One bounded index for the active workspace folder. A new query shares any scan already in flight. */
function createDirectorySearch({ now = Date.now } = {}) {
  let current
  const clear = () => {
    current?.controller.abort()
    current = null
  }
  const indexOf = (root, refresh = false) => {
    if (current?.root === root && !refresh && !current.error &&
      (current.finishedAt === null || now() - current.finishedAt < CACHE_MS)) return current
    clear()
    current = startIndex(root, now)
    return current
  }

  return {
    clear,
    prepare(root, refresh) { indexOf(root, refresh) },
    async search(root, query, signal) {
      signal.throwIfAborted()
      const index = indexOf(root)
      const terms = normalized(query).split(/\s+/)
      const matches = []
      const results = truncated => ({ entries: matches.sort((a, b) => a.path.localeCompare(b.path)), truncated })
      let offset = 0

      // Broad searches can return as soon as they hit their result cap, even while the index is building.
      for (;;) {
        signal.throwIfAborted()
        index.controller.signal.throwIfAborted()
        while (offset < index.entries.length) {
          const entry = index.entries[offset++]
          if (!terms.every(term => entry.searchable.includes(term))) continue
          if (matches.length === RESULT_LIMIT) return results(true)
          matches.push({ name: entry.name, kind: entry.kind, path: entry.path })
        }
        if (index.finishedAt !== null) {
          if (index.error) throw index.error
          return results(index.truncated)
        }
        await index.changed
      }
    }
  }
}

module.exports = { createDirectorySearch }
