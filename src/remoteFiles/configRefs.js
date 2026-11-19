// Where the value of a placeholder like `${UPLOAD_DIR:./uploads}` in a config file comes from: the
// lines that set that name in env files, compose files, Dockerfiles, YAML / properties keys, shell
// scripts and systemd units (docs/plan/2026-11-19-config-placeholder-definitions.md).
// Only what is read is searched: the callers bound the walk (local folder / SFTP parents).
const nodePath = require('path')

const NAME = /^[A-Za-z_][A-Za-z0-9_.\-[\]]{0,199}$/
const MAX_HITS_PER_FILE = 20
const MAX_LINE_SHOWN = 200

/** Files that can set a value */
function isCandidateFile(fileName) {
  const name = fileName.toLowerCase()
  return name === '.env' || name.startsWith('.env.') || name.endsWith('.env')
    || name.startsWith('dockerfile') || name.endsWith('.dockerfile')
    || name.endsWith('.yml') || name.endsWith('.yaml') || name.endsWith('.properties')
    || name.endsWith('.sh') || name.endsWith('.service') || name.endsWith('.conf')
}

const isValidName = (name) => typeof name === 'string' && NAME.test(name)
/** Spring's relaxed binding: UPLOAD_DIR, upload.dir, upload-dir and uploadDir are one name */
const loose = (name) => name.toLowerCase().replace(/[._\-[\]]/g, '')
const escape = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** The line without what is inside `${...}`, so a name used there does not look like a definition */
const withoutPlaceholders = (line) => line.replace(/\$\{[^}]*\}/g, '')

const shown = (line) => {
  const text = line.trim()
  return text.length > MAX_LINE_SHOWN ? `${text.slice(0, MAX_LINE_SHOWN)}…` : text
}

/** Lines of a YAML file with the full key path of each `key:` line (indentation decides the parents) */
function yamlKeys(lines) {
  const stack = []
  const keys = []
  lines.forEach((raw, index) => {
    if (/^\s*(#|$)/.test(raw) || /^\s*---/.test(raw)) return
    const match = /^(\s*)(?:-\s+)?["']?([^\s"':#][^"':#]*?)["']?\s*:(?:\s|$)/.exec(raw)
    if (!match) return
    const indent = match[1].length + (raw.slice(match[1].length).startsWith('- ') ? 2 : 0)
    while (stack.length && stack[stack.length - 1].indent >= indent) stack.pop()
    stack.push({ indent, key: match[2].trim() })
    keys.push({ index, key: match[2].trim(), path: stack.map(entry => entry.key).join('.') })
  })
  return keys
}

/**
 * The lines of one file that set `name`: [{ line (1-based), text }]. The kind of file decides the forms.
 */
function definitionsIn(fileName, text, name) {
  if (!isValidName(name) || typeof text !== 'string') return []
  const base = nodePath.basename(fileName).toLowerCase()
  const lines = text.split(/\r?\n/)
  const hits = new Map()
  const add = (index) => { if (!hits.has(index) && hits.size < MAX_HITS_PER_FILE) hits.set(index, shown(lines[index])) }
  const target = loose(name)
  const literal = escape(name)

  if (base.endsWith('.yml') || base.endsWith('.yaml')) {
    for (const { index, key, path } of yamlKeys(lines)) {
      if (key === name || loose(path) === target || loose(key) === target && !name.includes('.')) add(index)
    }
    // Compose's list form of environment: `- NAME=value`
    const listForm = new RegExp(`^\\s*-\\s*["']?${literal}=`)
    lines.forEach((line, index) => { if (listForm.test(line)) add(index) })
  } else if (base.endsWith('.properties')) {
    lines.forEach((line, index) => {
      if (/^\s*[#!]/.test(line)) return
      const key = /^\s*([^=:\s]+)\s*[=:]/.exec(line)?.[1]
      if (key && (key === name || loose(key) === target)) add(index)
    })
  } else if (base.startsWith('dockerfile') || base.endsWith('.dockerfile')) {
    const form = new RegExp(`^\\s*(ENV|ARG)\\s+(?:.*\\s)?${literal}(?:[=\\s]|$)`, 'i')
    lines.forEach((line, index) => { if (form.test(withoutPlaceholders(line))) add(index) })
  } else {
    // .env, shell scripts, systemd units, .conf: NAME=value, export NAME=value, Environment=NAME=value
    const assign = new RegExp(`^\\s*(?:export\\s+|Environment=["']?(?:\\S+\\s+)*)?${literal}\\s*=`)
    lines.forEach((line, index) => {
      if (/^\s*[#;]/.test(line)) return
      if (assign.test(withoutPlaceholders(line))) add(index)
    })
  }
  return [...hits.entries()].sort((a, b) => a[0] - b[0]).map(([index, line]) => ({ line: index + 1, text: line }))
}

/** `${NAME}` / `${NAME:default}` at a column of a line, or null */
function placeholderAt(line, column) {
  const pattern = /\$\{([A-Za-z_][A-Za-z0-9_.\-[\]]*)(?::([^}]*))?\}/g
  for (const match of line.matchAll(pattern)) {
    if (column >= match.index && column <= match.index + match[0].length) return { name: match[1], fallback: match[2] ?? null }
  }
  return null
}

const MAX_RESULTS = 100
/** Folders a project's settings are not in (generated, installed or tool folders) */
const SKIP_DIRS = new Set(['node_modules', '.git', 'build', 'dist', 'out', 'target', '.gradle', '.idea', '.vscode',
  'vendor', 'venv', '.venv', '__pycache__', 'coverage', '.next', '.nuxt', 'bin', 'obj', '.cache', 'release'])
const KEPT_DOT_DIRS = new Set(['.github', '.devcontainer', '.docker', '.config'])

/**
 * Every definition of `name` under a folder of this PC, nearest folders first. Links are not
 * followed (the walk stays inside the folder), and the walk is bounded.
 */
async function searchLocal(root, name, { fs = require('fs').promises, maxDepth = 8, maxFiles = 1500, maxBytes = 512 * 1024 } = {}) {
  const results = []
  let scanned = 0
  let truncated = false
  const queue = [{ dir: root, depth: 0 }]
  while (queue.length && !truncated) {
    const { dir, depth } = queue.shift()
    let entries
    try { entries = await fs.readdir(dir, { withFileTypes: true }) } catch { continue }
    entries.sort((a, b) => a.name.localeCompare(b.name))
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue
      const full = nodePath.join(dir, entry.name)
      if (entry.isDirectory()) {
        const skip = SKIP_DIRS.has(entry.name) || (entry.name.startsWith('.') && !KEPT_DOT_DIRS.has(entry.name))
        if (!skip && depth < maxDepth) queue.push({ dir: full, depth: depth + 1 })
        continue
      }
      if (!entry.isFile() || !isCandidateFile(entry.name)) continue
      if (++scanned > maxFiles) { truncated = true; break }
      try {
        const stats = await fs.stat(full)
        if (stats.size > maxBytes) continue
        const text = await fs.readFile(full, 'utf8')
        for (const hit of definitionsIn(entry.name, text, name)) {
          results.push({ path: full, shown: nodePath.relative(root, full) || entry.name, ...hit })
          if (results.length >= MAX_RESULTS) { truncated = true; break }
        }
      } catch { /* unreadable: skipped */ }
      if (truncated) break
    }
  }
  return { results, scanned: Math.min(scanned, maxFiles), truncated }
}

/**
 * Definitions on the server: the file's own folder and up to `maxUp` folders above it, candidate
 * names only, read over SFTP (no command runs on the server). `readText(path)` gives the text or
 * throws; `readdir(path)` gives SFTP entries ({ filename, longname, attrs }).
 */
async function searchRemote(startPath, name, { readText, readdir, maxUp = 3, maxFiles = 40, maxEntries = 500 }) {
  const results = []
  let scanned = 0
  let truncated = false
  const dirs = []
  for (let dir = nodePath.posix.dirname(startPath); dirs.length <= maxUp; dir = nodePath.posix.dirname(dir)) {
    dirs.push(dir)
    if (dir === '/' || dir === '.') break
  }
  for (const dir of dirs) {
    let entries
    try { entries = await readdir(dir) } catch { continue }
    const files = entries.slice(0, maxEntries)
      .filter(entry => {
        const isFile = typeof entry.attrs?.isFile === 'function' ? entry.attrs.isFile() : !String(entry.longname || '').startsWith('d')
        return isFile && isCandidateFile(entry.filename)
      })
      .map(entry => entry.filename)
      .sort()
    for (const file of files) {
      if (++scanned > maxFiles) { truncated = true; break }
      const full = nodePath.posix.join(dir, file)
      try {
        const text = await readText(full)
        for (const hit of definitionsIn(file, text, name)) {
          results.push({ path: full, shown: full, ...hit })
          if (results.length >= MAX_RESULTS) { truncated = true; break }
        }
      } catch { /* unreadable or too large: skipped */ }
      if (truncated) break
    }
    if (truncated) break
  }
  return { results, scanned: Math.min(scanned, maxFiles), truncated }
}

module.exports = { isCandidateFile, isValidName, definitionsIn, placeholderAt, yamlKeys, searchLocal, searchRemote }
