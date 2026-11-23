const fs = require('node:fs')
const path = require('node:path')
const { isMainThread, parentPort, workerData, Worker } = require('node:worker_threads')

const MAX_BOOKMARK_BYTES = 16 * 1024 * 1024
const MAX_HISTORY_SNAPSHOT_BYTES = 64 * 1024 * 1024
const MAX_RESULT_CHARS = 1_000_000
const MAX_HISTORY = 1000
const CHROMIUM_EPOCH_MS = 11_644_473_600_000

function profileFile(directory, name) {
  const file = path.join(directory, name)
  const info = fs.lstatSync(file, { throwIfNoEntry: false })
  if (!info) return null
  if (!info.isFile()) throw new Error('Expected a regular profile file')
  return { file, size: info.size }
}

function webPage(url, title) {
  if (typeof url !== 'string' || url.length > 4096) return null
  const parsed = URL.parse(url)
  if (!parsed || !['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password || parsed.href.length > 4096) return null
  return { url: parsed.href, title: typeof title === 'string' ? title.slice(0, 300) : '' }
}

function readBookmarks(directory) {
  const source = profileFile(directory, 'Bookmarks')
  if (!source) return { entries: [] }
  if (source.size > MAX_BOOKMARK_BYTES) throw new Error('Bookmark file is too large')
  const { roots } = JSON.parse(fs.readFileSync(source.file, 'utf8').replace(/^\uFEFF/, ''))
  if (!roots || typeof roots !== 'object' || Array.isArray(roots)) throw new Error('Missing bookmark roots')
  const pending = Object.values(roots).reverse()
  const seen = new Set()
  const entries = []
  let size = 0
  while (pending.length) {
    const node = pending.pop()
    if (node?.type === 'folder' && Array.isArray(node.children)) {
      for (let i = node.children.length - 1; i >= 0; i--) pending.push(node.children[i])
    }
    const page = node?.type === 'url' && webPage(node.url, node.name)
    if (!page || seen.has(page.url)) continue
    size += JSON.stringify(page).length + 1
    if (size > MAX_RESULT_CHARS) return { entries, limited: true }
    seen.add(page.url)
    entries.push(page)
  }
  return { entries }
}

function recentVisits(db) {
  db.exec('PRAGMA trusted_schema = OFF; PRAGMA query_only = ON')
  const rows = db.prepare(`
    SELECT url, substr(title, 1, 300) AS title, last_visit_time FROM urls
    WHERE hidden = 0 AND visit_count > 0 AND last_visit_time > 0 AND length(url) <= 4096
      AND (url LIKE 'https://%' OR url LIKE 'http://%')
    ORDER BY last_visit_time DESC LIMIT ?
  `)
  rows.setReadBigInts(true)
  const entries = []
  const seen = new Set()
  const now = Date.now()
  let size = 0
  for (const row of rows.iterate(MAX_HISTORY + 1)) {
    const page = webPage(row.url, row.title)
    if (typeof row.last_visit_time !== 'bigint') continue
    const visitedAt = Number(row.last_visit_time / 1000n) - CHROMIUM_EPOCH_MS
    if (!page || seen.has(page.url) || visitedAt <= 0 || visitedAt > now) continue
    const entry = { ...page, visitedAt }
    size += JSON.stringify(entry).length + 1
    if (entries.length === MAX_HISTORY || size > MAX_RESULT_CHARS) return { entries, limited: true }
    seen.add(page.url)
    entries.push(entry)
  }
  return { entries }
}

function snapshotHistory(DatabaseSync, directory, source) {
  if (typeof DatabaseSync.prototype.deserialize !== 'function' || source.size > MAX_HISTORY_SNAPSHOT_BYTES) return null
  const hasPendingWrites = () => ['History-journal', 'History-wal'].some(name => profileFile(directory, name)?.size > 0)
  // A running browser can hold SQLite's exclusive lock between writes. Only read a stable,
  // committed rollback-mode file into memory. A live journal or WAL requires the normal reader.
  if (hasPendingWrites()) return null
  const contents = fs.readFileSync(source.file)
  if (contents.length !== source.size || contents[18] !== 1 || contents[19] !== 1 || hasPendingWrites()) return null
  if (!contents.equals(fs.readFileSync(source.file)) || hasPendingWrites()) return null
  const db = new DatabaseSync(':memory:')
  try {
    db.deserialize(contents)
    db.exec('PRAGMA trusted_schema = OFF; PRAGMA query_only = ON')
    if (db.prepare('PRAGMA quick_check(1)').get()?.quick_check !== 'ok') return null
    return recentVisits(db)
  } finally { db.close() }
}

function readHistory(directory) {
  const source = profileFile(directory, 'History')
  if (!source) return { entries: [] }
  const { DatabaseSync } = require('node:sqlite')
  let db
  try {
    db = new DatabaseSync(source.file, { readOnly: true, timeout: 500 })
    return recentVisits(db)
  } catch (error) {
    // SQLITE_BUSY and SQLITE_LOCKED, including their extended codes.
    if ([5, 6].includes(error.errcode & 255)) {
      const snapshot = snapshotHistory(DatabaseSync, directory, source)
      if (snapshot) return snapshot
    }
    throw error
  } finally {
    db?.close()
  }
}

function readCategory(read, directory, message) {
  try { return read(directory) } catch { return { error: message } }
}

function importBrowserProfile(directory, { bookmarks, history }) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(__filename, { workerData: { directory, bookmarks, history } })
    const fail = () => reject(new Error('브라우저 프로필을 읽을 수 없습니다. 원본 브라우저를 닫고 다시 시도해 주세요.'))
    const timeout = setTimeout(() => { void worker.terminate(); fail() }, 10_000)
    worker.once('message', result => { clearTimeout(timeout); resolve(result) })
    worker.once('error', () => { clearTimeout(timeout); fail() })
    worker.once('exit', () => { clearTimeout(timeout); fail() })
  })
}

if (!isMainThread && workerData?.directory) {
  const { directory, bookmarks, history } = workerData
  parentPort.postMessage({
    ...(bookmarks && { bookmarks: readCategory(readBookmarks, directory, '즐겨찾기 파일을 읽을 수 없습니다.') }),
    ...(history && { history: readCategory(readHistory, directory, '방문 기록을 읽을 수 없습니다. 원본 브라우저를 완전히 종료한 뒤 다시 시도해 주세요.') }),
  })
}

module.exports = { importBrowserProfile }
