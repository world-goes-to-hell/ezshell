// Search names and paths inside a working directory that roots.js has already resolved
// (docs/plan/2026-11-24-workspace-file-search-index.md). The first scan reads 16 folders at a time;
// a recursive fs.watch then keeps the list current: changed folders are read again (the event's file
// name only says which folder to read), so a later search does not scan the tree again.
const fs = require('fs')
const path = require('path')
const { sameOrInside } = require('./roots.js')
const { compileSearchPattern, runRegexSearch } = require('./regexSearch.js')

const RESULT_LIMIT = 200
const ENTRY_LIMIT = 200000
const TIME_LIMIT_MS = 8000
const CONCURRENCY = 16
const ROOT_LIMIT = 3
const SETTLE_MS = 150
// More changed folders than this in one batch (npm install): scanning again on the next search is cheaper
const BATCH_DIRECTORY_LIMIT = 2000
// Only when fs.watch is not available: the list is then kept 10 seconds, as before
const UNWATCHED_CACHE_MS = 10000
const UPDATE_INTERVAL = 128
const normalized = value => value.normalize('NFC').toLowerCase().replace(/\\/g, '/')
const pathKey = value => process.platform === 'win32' ? value.toLowerCase() : value
const parentOf = relative => relative.includes('/') ? relative.slice(0, relative.lastIndexOf('/')) : ''
const depthOf = relative => relative ? relative.split('/').length : 0
const isGitPath = relative => relative.split('/').some(part => part.toLowerCase() === '.git')
/**
 * Installed and generated folders. By default they are listed (the folder itself can be found) but not
 * read: a project's node_modules and build output are most of its entries (this repository: 39,000 of
 * 43,000) and bury the files the user wrote. The search can include them on request (`includeAll`).
 */
const SKIPPED_DIRS = new Set(['node_modules', 'bower_components', '.gradle', 'build', 'dist', 'out', 'target',
  'release', 'coverage', '.next', '.nuxt', '.cache', '__pycache__', '.venv', 'venv', 'obj'])
const isSkippedName = name => SKIPPED_DIRS.has(name.toLowerCase())
// A change below a skipped folder (not the folder itself) does not touch the list
const isBelowSkipped = relative => relative.split('/').slice(0, -1).some(isSkippedName)
const SKIPPED_NAME_LIMIT = 8
const insideKey = (parent, child) => child === parent || child.startsWith(`${parent}/`)
const defaultWatch = (root, listener) => fs.watch(root, { recursive: true, persistent: false }, listener)

/**
 * The entries of one folder, or null when it is gone or has been replaced by a link since its parent
 * was listed (the real path must be inside the root and equal to the path asked for).
 */
async function readDirectory(root, relative, skip) {
  const target = relative ? path.join(root, relative) : root
  try {
    const directory = relative ? await fs.promises.realpath(target) : root
    if (!sameOrInside(pathKey(root), pathKey(directory)) || pathKey(directory) !== pathKey(target)) return null
    const listed = await fs.promises.readdir(directory, { withFileTypes: true })
    const entries = []
    for (const entry of listed) {
      if (entry.name.toLowerCase() === '.git') continue
      const kind = entry.isSymbolicLink() ? 'link' : entry.isDirectory() ? 'directory' : entry.isFile() ? 'file' : null
      if (!kind) continue
      const entryPath = relative ? `${relative}/${entry.name}` : entry.name
      const skipped = skip && kind === 'directory' && isSkippedName(entry.name)
      entries.push({ name: entry.name, kind, path: entryPath, searchable: normalized(entryPath), ...(skipped ? { skipped: true } : {}) })
    }
    return entries
  } catch (error) {
    if (relative && (error.code === 'ENOENT' || error.code === 'ENOTDIR')) return null
    throw error
  }
}

const descends = child => child.kind === 'directory' && !child.skipped

function createIndex(root, { now, watch, skip }) {
  const read = relative => readDirectory(root, relative, skip)
  const controller = new AbortController()
  const { signal } = controller
  const directories = new Map() // pathKey(relative folder) -> { path, children }
  const dirty = new Set() // folders to read again
  let total = 0
  let flat = [] // grows during the first scan, rebuilt from `directories` after a change
  let flatDirty = false
  let timer = null
  let applying = false
  let notify
  const index = {
    root, controller, truncated: false, error: null, finished: false, stale: false, builtAt: null,
    watched: false, changed: null
  }
  const waitForChange = () => { index.changed = new Promise(resolve => { notify = resolve }) }
  waitForChange()
  const publish = () => {
    const previous = notify
    waitForChange()
    previous()
  }

  const store = (relative, children) => {
    const key = pathKey(relative)
    total += children.length - (directories.get(key)?.children.length ?? 0)
    directories.set(key, { path: relative, children })
    if (index.finished) flatDirty = true
  }
  const removeTree = (relative) => {
    const node = directories.get(pathKey(relative))
    if (!node) return
    directories.delete(pathKey(relative))
    total -= node.children.length
    for (const child of node.children) if (child.kind === 'directory') removeTree(child.path)
    flatDirty = true
  }
  const withinLimit = (children, previous = 0) => {
    const room = ENTRY_LIMIT - total + previous
    return children.length > room ? children.slice(0, Math.max(0, room)) : children
  }

  /** Read the trees below `starts`, CONCURRENCY folders at a time. Resolves { truncated, incomplete }. */
  function walk(starts, visit) {
    const deadline = Date.now() + TIME_LIMIT_MS
    const queue = [...starts]
    let head = 0
    let active = 0
    let settled = false
    let truncated = false
    let incomplete = false
    return new Promise((resolve, reject) => {
      const finish = (error) => {
        if (settled) return
        settled = true
        if (error) reject(error)
        else resolve({ truncated, incomplete })
      }
      const take = (relative, entries) => {
        if (!entries) { incomplete = true; return }
        const children = withinLimit(entries)
        if (children.length < entries.length) truncated = true
        visit(relative, children)
        for (const child of children) if (descends(child)) queue.push(child.path)
      }
      const pump = () => {
        if (settled) return
        if (signal.aborted) return finish(signal.reason)
        while (active < CONCURRENCY && head < queue.length) {
          if (Date.now() >= deadline || total >= ENTRY_LIMIT) {
            truncated = true
            head = queue.length
            break
          }
          const relative = queue[head++]
          active++
          read(relative).then(
            entries => { if (!signal.aborted) take(relative, entries) },
            error => { if (relative) incomplete = true; else finish(error) }
          ).catch(finish).finally(() => { active--; pump() })
        }
        if (active === 0 && head >= queue.length) finish()
      }
      pump()
    })
  }

  // Read changed folders again and swap their entries. Removed folders take their trees with them,
  // new folders are scanned. A folder the index has not read stands for its nearest read parent.
  async function refresh(batch) {
    const queue = batch.sort((a, b) => depthOf(a) - depthOf(b))
    const done = new Set()
    const scanned = []
    for (const changed of queue) {
      let relative = changed
      while (relative && !directories.has(pathKey(relative))) relative = parentOf(relative)
      const key = pathKey(relative)
      if (done.has(key) || scanned.some(parent => insideKey(parent, key))) continue
      done.add(key)
      signal.throwIfAborted()
      let entries
      try {
        entries = await read(relative)
      } catch (error) {
        if (!relative) throw error
        index.truncated = true
        continue
      }
      signal.throwIfAborted()
      if (!entries) {
        // Gone or now a link: drop its tree and its entry in the parent (the parent may already be read)
        removeTree(relative)
        const parent = directories.get(pathKey(parentOf(relative)))
        if (parent) store(parent.path, parent.children.filter(child => pathKey(child.path) !== key))
        continue
      }
      const previous = directories.get(key)?.children ?? []
      const before = new Set(previous.filter(child => child.kind === 'directory').map(child => pathKey(child.path)))
      const children = withinLimit(entries, previous.length)
      if (children.length < entries.length) index.truncated = true
      const after = new Set(children.filter(child => child.kind === 'directory').map(child => pathKey(child.path)))
      for (const child of previous) if (child.kind === 'directory' && !after.has(pathKey(child.path))) removeTree(child.path)
      store(relative, children)
      const fresh = children.filter(child => descends(child) && !before.has(pathKey(child.path))).map(child => child.path)
      if (!fresh.length) continue
      scanned.push(...fresh.map(pathKey))
      const result = await walk(fresh, store)
      if (result.truncated || result.incomplete) index.truncated = true
    }
  }

  const closeWatch = () => {
    index.watcher?.close()
    index.watcher = null
    clearTimeout(timer)
    timer = null
    dirty.clear()
  }
  const markStale = () => {
    index.stale = true
    closeWatch()
  }
  async function applyChanges() {
    timer = null
    if (applying) return
    applying = true
    try {
      while (dirty.size && !index.stale && !signal.aborted) {
        const batch = [...dirty]
        dirty.clear()
        await refresh(batch)
      }
    } catch {
      if (!signal.aborted) markStale()
    } finally {
      applying = false
    }
  }
  const schedule = () => {
    if (index.finished && !timer && !applying && dirty.size) timer = setTimeout(applyChanges, SETTLE_MS)
  }
  const onChange = (eventType, filename) => {
    if (index.stale || signal.aborted) return
    // No name: the change buffer overflowed and changes were lost
    if (filename == null) return markStale()
    // A modified file keeps its name; only creations, removals and renames change the list
    if (eventType !== 'rename') return
    const relative = path.posix.normalize(String(filename).replace(/\\/g, '/'))
    if (relative === '..' || relative.startsWith('../') || path.posix.isAbsolute(relative)) return
    const name = relative === '.' ? '' : relative
    if (!name || isGitPath(name) || (skip && isBelowSkipped(name))) return
    dirty.add(parentOf(name))
    if (dirty.size > BATCH_DIRECTORY_LIMIT) return markStale()
    schedule()
  }

  // Watch before the first scan so changes made during it are not lost (they are applied after it)
  try {
    index.watcher = watch(root, onChange)
    index.watcher.on?.('error', () => { if (!signal.aborted) markStale() })
    index.watched = true
  } catch {
    index.watcher = null
  }

  let published = 0
  void walk([''], (relative, children) => {
    store(relative, children)
    for (const child of children) flat.push(child)
    if (flat.length - published >= UPDATE_INTERVAL) {
      published = flat.length
      publish()
    }
  }).then(
    result => { index.truncated = result.truncated || result.incomplete },
    error => {
      index.error = error
      closeWatch()
    }
  ).finally(() => {
    index.finished = true
    index.builtAt = now()
    publish()
    schedule()
  })

  index.list = () => {
    if (!index.finished || !flatDirty) return flat
    const next = []
    for (const node of directories.values()) for (const child of node.children) next.push(child)
    flat = next
    flatDirty = false
    return flat
  }
  index.usable = (time) => !index.error && !index.stale &&
    (index.watched || !index.finished || time - index.builtAt < UNWATCHED_CACHE_MS)
  index.dispose = () => {
    controller.abort()
    closeWatch()
    publish()
  }
  return index
}

/** How many installed/generated folders the default search did not read, and their names */
function skippedOf(list) {
  let count = 0
  const names = new Map()
  for (const entry of list) {
    if (!entry.skipped) continue
    count++
    const key = entry.name.toLowerCase()
    if (!names.has(key) && names.size < SKIPPED_NAME_LIMIT) names.set(key, entry.name)
  }
  return count ? { skipped: { count, names: [...names.values()] } } : {}
}

/**
 * Indexes of the last ROOT_LIMIT workspace folders (a folder searched with and without the skipped
 * folders has two indexes). A new query shares any scan already in flight.
 * `watch(root, listener)` is fs.watch (recursive) unless a test gives its own.
 */
function createDirectorySearch({ now = Date.now, watch = defaultWatch } = {}) {
  const indexes = new Map()
  const clear = () => {
    for (const index of indexes.values()) index.dispose()
    indexes.clear()
  }
  const indexOf = (root, refresh = false, includeAll = false) => {
    const key = `${includeAll ? 'all' : 'skip'}\0${root}`
    const current = indexes.get(key)
    indexes.delete(key)
    if (current && !refresh && current.usable(now())) {
      indexes.set(key, current)
      return current
    }
    current?.dispose()
    const index = createIndex(root, { now, watch, skip: !includeAll })
    indexes.set(key, index)
    for (const [oldest, old] of indexes) {
      if (indexes.size <= ROOT_LIMIT) break
      indexes.delete(oldest)
      old.dispose()
    }
    return index
  }

  return {
    clear,
    prepare(root, refresh, includeAll) { indexOf(root, refresh === true, includeAll === true) },
    async search(root, query, signal, _worktreeOnly, includeAll, regex) {
      signal.throwIfAborted()
      const index = indexOf(root, false, includeAll === true)
      if (regex) {
        compileSearchPattern(query, false)
        while (!index.finished) {
          signal.throwIfAborted()
          index.controller.signal.throwIfAborted()
          await index.changed
        }
        if (index.error) throw index.error
        const listing = index.list()
        const paths = listing.filter(entry => entry.kind === 'file').map(entry => entry.path)
        const result = await runRegexSearch({ type: 'paths', paths, query, limit: RESULT_LIMIT }, { signal, timeout: TIME_LIMIT_MS })
        return {
          entries: result.entries.sort((a, b) => a.path.localeCompare(b.path)),
          truncated: result.truncated || index.truncated,
          ...(includeAll === true ? { includedAll: true } : skippedOf(listing))
        }
      }
      const terms = normalized(query).split(/\s+/)
      let matches = []
      let source = null
      let offset = 0
      const results = truncated => ({
        entries: matches.sort((a, b) => a.path.localeCompare(b.path)),
        truncated,
        ...(includeAll === true ? { includedAll: true } : skippedOf(index.list()))
      })

      // Broad searches can return as soon as they hit their result cap, even while the index is building.
      for (;;) {
        signal.throwIfAborted()
        index.controller.signal.throwIfAborted()
        const list = index.list()
        if (list !== source) {
          source = list
          offset = 0
          matches = []
        }
        while (offset < list.length) {
          const entry = list[offset++]
          if (!terms.every(term => entry.searchable.includes(term))) continue
          if (matches.length === RESULT_LIMIT) return results(true)
          matches.push({ name: entry.name, kind: entry.kind, path: entry.path })
        }
        if (index.finished) {
          if (index.error) throw index.error
          return results(index.truncated)
        }
        await index.changed
      }
    }
  }
}

module.exports = { createDirectorySearch, SKIPPED_DIRS }
