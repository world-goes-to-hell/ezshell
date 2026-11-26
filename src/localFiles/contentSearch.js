// 프로젝트 검색의 내용 검색 (docs/plan/2026-11-26-project-search.md): the text in the files of a folder roots.js
// has already resolved. In a repository `git grep` does it (ignored and binary files left out, new files in);
// elsewhere the files are read here, leaving out the installed and generated folders the name search skips.
// Both stop at their limits and say so. The text is a fixed string, never a pattern or an option.
const { spawn } = require('child_process')
const fs = require('fs')
const path = require('path')
const { SAFE, repoTop } = require('./git.js')
const { SKIPPED_DIRS } = require('./search.js')

const LIMITS = { maxLines: 500, maxFiles: 200, perFile: 50, timeMs: 8000 }
const QUERY_MAX = 200
const LINE_CHARS = 300
const MAX_FILE_BYTES = 1024 * 1024
const BINARY_PROBE_BYTES = 8000
const CONTROL = /[\u0000-\u001f\u007f]/

// The installed and generated folders the name search skips stay out here too, also when the repository
// does not ignore them (an untracked node_modules); any case, at any depth
const SKIPPED_PATHSPECS = [...SKIPPED_DIRS].map(name => `:(exclude,glob,icase)**/${name}/**`)

class ContentSearchError extends Error {}

/** One line of 1 to 200 characters with something other than spaces */
function checkContentQuery(query) {
  if (typeof query !== 'string' || query.length === 0 || query.length > QUERY_MAX || CONTROL.test(query) || !/\S/.test(query)) {
    throw new ContentSearchError('검색어는 한 줄로 1~200자까지 입력할 수 있습니다.')
  }
  return query
}

function aborted() {
  const error = new ContentSearchError('검색을 취소했습니다.')
  error.name = 'AbortError'
  return error
}

/** A long line (minified code) around the first place it was found */
function cutLine(text, query, caseSensitive) {
  const line = text.replace(/\r$/, '')
  if (line.length <= LINE_CHARS) return line
  const at = Math.max(0, caseSensitive ? line.indexOf(query) : line.toLowerCase().indexOf(query.toLowerCase()))
  const start = Math.max(0, Math.min(at - 100, line.length - LINE_CHARS))
  const end = Math.min(line.length, start + LINE_CHARS)
  return `${start > 0 ? '…' : ''}${line.slice(start, end)}${end < line.length ? '…' : ''}`
}

/** Results gathered in order, per file, within the limits */
function createCollector(limits) {
  const files = []
  const byPath = new Map()
  let lines = 0
  let truncated = false
  return {
    /** false once nothing more is taken (the search can stop) */
    add(relative, line, text) {
      let file = byPath.get(relative)
      if (!file) {
        if (files.length >= limits.maxFiles) { truncated = true; return false }
        file = { path: relative, matches: [] }
        byPath.set(relative, file)
        files.push(file)
      }
      if (file.matches.length >= limits.perFile) { truncated = true; return true }
      file.matches.push({ line, text })
      lines++
      if (lines >= limits.maxLines) { truncated = true; return false }
      return true
    },
    stop() { truncated = true },
    result(engine) { return { engine, files, truncated } }
  }
}

function gitGrep(root, query, { caseSensitive, signal, limits }) {
  return new Promise((resolve, reject) => {
    const collector = createCollector(limits)
    const args = [...SAFE, 'grep', '-n', '-z', '-I', '--no-color', '--untracked', '--exclude-standard', '-F',
      ...(caseSensitive ? [] : ['-i']), '-e', query, '--', '.', ...SKIPPED_PATHSPECS]
    const child = spawn('git', args, { cwd: root, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] })
    let pending = ''
    let stopped = false
    let settled = false
    const stop = () => {
      if (stopped) return
      stopped = true
      child.kill()
    }
    const timer = setTimeout(() => { collector.stop(); stop() }, limits.timeMs)
    const onAbort = () => { stop(); finish(aborted()) }
    signal?.addEventListener('abort', onAbort, { once: true })
    function finish(error, value) {
      if (settled) return
      settled = true
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      if (error) reject(error)
      else resolve(value)
    }
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', chunk => {
      if (stopped) return
      pending += chunk
      let end
      while ((end = pending.indexOf('\n')) >= 0) {
        const record = pending.slice(0, end)
        pending = pending.slice(end + 1)
        // path \0 line \0 text: a path may hold any character but NUL
        const first = record.indexOf('\0')
        const second = first < 0 ? -1 : record.indexOf('\0', first + 1)
        if (second < 0) continue
        const line = Number(record.slice(first + 1, second))
        if (!Number.isSafeInteger(line)) continue
        if (!collector.add(record.slice(0, first), line, cutLine(record.slice(second + 1), query, caseSensitive))) {
          stop()
          return
        }
      }
    })
    child.on('error', error => finish(error))
    child.on('close', code => {
      // 1: nothing found; a stop of ours ends it with a signal
      if (stopped || code === 0 || code === 1) finish(null, collector.result('git'))
      else finish(new ContentSearchError(`git grep 이 끝나지 못했습니다 (${code}).`))
    })
  })
}

async function readText(file) {
  const handle = await fs.promises.open(file, 'r')
  try {
    const { size } = await handle.stat()
    if (size > MAX_FILE_BYTES) return null
    const data = await handle.readFile()
    if (data.subarray(0, BINARY_PROBE_BYTES).includes(0)) return null
    return data.toString('utf8')
  } finally {
    await handle.close()
  }
}

async function scan(root, query, { caseSensitive, signal, limits }) {
  const collector = createCollector(limits)
  const needle = caseSensitive ? query : query.toLowerCase()
  const deadline = Date.now() + limits.timeMs
  const folders = ['']
  while (folders.length) {
    const relative = folders.shift()
    let entries
    try {
      entries = await fs.promises.readdir(path.join(root, relative), { withFileTypes: true })
    } catch { continue }
    entries.sort((a, b) => a.name.localeCompare(b.name))
    for (const entry of entries) {
      if (signal?.aborted) throw aborted()
      if (Date.now() > deadline) { collector.stop(); return collector.result('scan') }
      const child = relative ? `${relative}/${entry.name}` : entry.name
      // Links are not followed: one could lead outside the folder
      if (entry.isSymbolicLink()) continue
      if (entry.isDirectory()) {
        if (entry.name.toLowerCase() !== '.git' && !SKIPPED_DIRS.has(entry.name.toLowerCase())) folders.push(child)
        continue
      }
      if (!entry.isFile()) continue
      const text = await readText(path.join(root, child)).catch(() => null)
      if (text === null) continue
      const lines = text.split('\n')
      for (let index = 0; index < lines.length; index++) {
        const line = lines[index]
        if (!(caseSensitive ? line : line.toLowerCase()).includes(needle)) continue
        if (!collector.add(child, index + 1, cutLine(line, query, caseSensitive))) return collector.result('scan')
      }
    }
  }
  return collector.result('scan')
}

/**
 * The lines holding `query` in the files under `root` (a real folder roots.js accepted).
 * { engine: 'git' | 'scan', files: [{ path (relative, with /), matches: [{ line, text }] }], truncated }
 */
async function searchContent(root, query, { caseSensitive = false, signal, ...limits } = {}) {
  checkContentQuery(query)
  if (signal?.aborted) throw aborted()
  const options = { caseSensitive: caseSensitive === true, signal, limits: { ...LIMITS, ...limits } }
  if (await repoTop(root)) {
    try {
      return await gitGrep(root, query, options)
    } catch (error) {
      if (error.name === 'AbortError') throw error
      // Git missing or refusing the folder: read the files instead
    }
  }
  return scan(root, query, options)
}

module.exports = { searchContent, checkContentQuery, ContentSearchError, LIMITS }
