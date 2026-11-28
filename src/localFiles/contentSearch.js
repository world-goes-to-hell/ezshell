// 프로젝트 검색의 내용 검색 (docs/plan/2026-11-26-project-search.md): the text in the files of a folder roots.js
// has already resolved. In a repository `git grep` does it (ignored and binary files left out, new files in);
// elsewhere the files are read here, leaving out the installed and generated folders the name search skips.
// Both stop at their limits and say so. Regular expressions run in a worker.
const { execFile, spawn } = require('child_process')
const { promisify } = require('node:util')
const fs = require('fs')
const path = require('path')
const { SAFE, repoTop } = require('./git.js')
const { sameOrInside } = require('./roots.js')
const { SKIPPED_DIRS } = require('./search.js')
const { compileSearchPattern, matchRanges, runRegexSearch } = require('./regexSearch.js')
const exec = promisify(execFile)

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

function regexPreview(line, { at, ranges }) {
  if (line.length <= LINE_CHARS) return { text: line, ranges }
  const start = Math.max(0, Math.min(at - 100, line.length - LINE_CHARS))
  const end = Math.min(line.length, start + LINE_CHARS)
  const prefix = start > 0 ? '…' : ''
  return {
    text: `${prefix}${line.slice(start, end)}${end < line.length ? '…' : ''}`,
    ranges: ranges.filter(([from, to]) => from < end && to > start)
      .map(([from, to]) => [Math.max(from, start) - start + prefix.length, Math.min(to, end) - start + prefix.length])
  }
}

/** Results gathered in order, per file, within the limits */
function createCollector(limits) {
  const files = []
  const byPath = new Map()
  let lines = 0
  let truncated = false
  return {
    /** false once nothing more is taken (the search can stop) */
    add(relative, line, text, ranges) {
      let file = byPath.get(relative)
      if (!file) {
        if (files.length >= limits.maxFiles) { truncated = true; return false }
        file = { path: relative, matches: [] }
        byPath.set(relative, file)
        files.push(file)
      }
      if (file.matches.length >= limits.perFile) { truncated = true; return true }
      file.matches.push({ line, text, ...(ranges && { ranges }) })
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

async function* localFiles(root, withinTime) {
  const folders = ['']
  for (let at = 0; at < folders.length && withinTime(); at++) {
    const relative = folders[at]
    let entries
    try {
      entries = await fs.promises.readdir(path.join(root, relative), { withFileTypes: true })
    } catch { continue }
    entries.sort((a, b) => a.name.localeCompare(b.name))
    for (const entry of entries) {
      if (!withinTime()) return
      const child = relative ? `${relative}/${entry.name}` : entry.name
      // Links are not followed: one could lead outside the folder
      if (entry.isSymbolicLink()) continue
      if (entry.isDirectory()) {
        if (entry.name.toLowerCase() !== '.git' && !SKIPPED_DIRS.has(entry.name.toLowerCase())) folders.push(child)
        continue
      }
      if (entry.isFile()) yield child
    }
  }
}

async function scanContent({ root, query, caseSensitive, signal, limits, regex, paths }) {
  const collector = createCollector(limits)
  const needle = caseSensitive ? query : query.toLowerCase()
  const pattern = regex ? compileSearchPattern(query, caseSensitive) : null
  const deadline = Date.now() + limits.timeMs
  const result = () => collector.result(paths ? 'git' : 'scan')
  const withinTime = () => {
    if (signal?.aborted) throw aborted()
    if (Date.now() <= deadline) return true
    collector.stop()
    return false
  }
  for await (const child of paths ?? localFiles(root, withinTime)) {
    if (!withinTime()) break
    const file = path.join(root, child)
    const text = await (async () => {
      // Git's list can include a symbolic link or a submodule entry. Read regular files only.
      if (paths && (!sameOrInside(root, file) || !(await fs.promises.lstat(file)).isFile() ||
        path.relative(file, await fs.promises.realpath(file)) !== '')) return null
      return readText(file)
    })().catch(() => null)
    if (text === null) continue
    const lines = text.split('\n')
    if (lines.at(-1) === '') lines.pop()
    for (let index = 0; index < lines.length; index++) {
      const line = lines[index]
      if (pattern) {
        const clean = line.replace(/\r$/, '')
        const match = matchRanges(clean, pattern)
        if (!match) continue
        const preview = regexPreview(clean, match)
        if (!collector.add(child, index + 1, preview.text, preview.ranges)) return result()
      } else if ((caseSensitive ? line : line.toLowerCase()).includes(needle) &&
          !collector.add(child, index + 1, cutLine(line, query, caseSensitive))) return result()
    }
  }
  return result()
}

async function searchRegexContent(root, query, { caseSensitive, signal, limits }) {
  compileSearchPattern(query, caseSensitive)
  const deadline = Date.now() + limits.timeMs
  let paths
  if (await repoTop(root)) {
    signal?.throwIfAborted()
    const { stdout } = await exec('git', [...SAFE, 'ls-files', '-z', '--cached', '--others', '--exclude-standard',
      '--deduplicate', '--', '.', ...SKIPPED_PATHSPECS], {
      cwd: root, signal, timeout: Math.max(1, deadline - Date.now()), windowsHide: true, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024
    })
    paths = stdout.split('\0').filter(Boolean)
  }
  const timeMs = Math.max(1, deadline - Date.now())
  return runRegexSearch({ type: 'content', root, query, caseSensitive, regex: true, paths, limits: { ...limits, timeMs } },
    { signal, timeout: timeMs + 300 })
}

/**
 * The lines holding `query` in the files under `root` (a real folder roots.js accepted).
 * { engine: 'git' | 'scan', files: [{ path (relative, with /), matches: [{ line, text }] }], truncated }
 */
async function searchContent(root, query, { caseSensitive = false, regex = false, signal, ...limits } = {}) {
  checkContentQuery(query)
  if (signal?.aborted) throw aborted()
  const options = { caseSensitive: caseSensitive === true, signal, limits: { ...LIMITS, ...limits } }
  if (regex === true) return searchRegexContent(root, query, options)
  if (await repoTop(root)) {
    try {
      return await gitGrep(root, query, options)
    } catch (error) {
      if (error.name === 'AbortError') throw error
      // Git missing or refusing the folder: read the files instead
    }
  }
  return scanContent({ root, query, ...options })
}

module.exports = { searchContent, scanContent, checkContentQuery, ContentSearchError, LIMITS }
