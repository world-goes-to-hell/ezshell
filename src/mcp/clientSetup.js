// Writes the ezShell MCP server entry into a Claude Code config file (.mcp.json or ~/.claude.json).
// Everything else in the file is kept; a broken file is refused instead of repaired.
const fs = require('fs')

const TOKEN_ENV_VAR = 'EZSHELL_MCP_TOKEN'
const BACKUP_SUFFIX = '.ezshell-backup'
const TEMP_SUFFIX = '.ezshell-tmp'
const DEFAULT_INDENT = 2
const BOM = String.fromCharCode(0xfeff)

class SetupError extends Error {}

const isPlainObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)

/** With `useEnvToken` the file only names the variable, so it can be committed without leaking the token. */
function buildServerEntry({ url, token, useEnvToken }) {
  const secret = useEnvToken ? `\${${TOKEN_ENV_VAR}}` : token
  return { type: 'http', url, headers: { Authorization: `Bearer ${secret}` } }
}

/** The file's bytes and text, or null when it does not exist. Text that is not UTF-8 would be rewritten damaged, so it is refused. */
function readFile(fileSystem, filePath) {
  let bytes
  try {
    bytes = fileSystem.readFileSync(filePath)
  } catch (err) {
    if (err && err.code === 'ENOENT') return null
    throw new SetupError(`${filePath} 을(를) 읽지 못했습니다: ${err.message}`)
  }
  const text = bytes.toString('utf8')
  if (!Buffer.from(text, 'utf8').equals(bytes)) {
    throw new SetupError(`${filePath} 이(가) UTF-8 형식이 아니라서 수정하지 않았습니다.`)
  }
  return { bytes, text }
}

const stripBom = (text) => (text.startsWith(BOM) ? text.slice(1) : text)

function parseDocument(text, filePath, allowEmpty) {
  const body = stripBom(text)
  if (body.trim() === '') {
    if (allowEmpty) return {}
    throw new SetupError(`${filePath} 이(가) 비어 있어 수정하지 않았습니다. Claude Code 를 한 번 실행한 뒤 다시 시도하세요.`)
  }
  let doc
  try {
    doc = JSON.parse(body)
  } catch {
    throw new SetupError(`${filePath} 의 JSON 형식이 올바르지 않아 수정하지 않았습니다. 파일을 고친 뒤 다시 시도하세요.`)
  }
  if (!isPlainObject(doc)) throw new SetupError(`${filePath} 의 최상위가 JSON 객체가 아니라서 수정하지 않았습니다.`)
  if (doc.mcpServers !== undefined && !isPlainObject(doc.mcpServers)) {
    throw new SetupError(`${filePath} 의 mcpServers 가 객체가 아니라서 수정하지 않았습니다.`)
  }
  return doc
}

function detectIndent(text) {
  const match = /\n([ \t]+)"/.exec(text)
  if (!match) return DEFAULT_INDENT
  return match[1].includes('\t') ? '\t' : match[1].length
}

/** Same indentation, line endings and byte order mark as the original, so a committed .mcp.json diffs cleanly */
function formatLike(originalText, doc) {
  const original = originalText || ''
  const eol = original.includes('\r\n') ? '\r\n' : '\n'
  // JSON.stringify escapes newlines inside strings, so every real newline is a line break
  const json = JSON.stringify(doc, null, detectIndent(original)).split('\n').join(eol)
  return `${original.startsWith(BOM) ? BOM : ''}${json}${eol}`
}

/** Projects whose local-scope entry of the same name takes precedence over the user-scope one. */
function findShadowedProjects(doc, name) {
  if (!isPlainObject(doc.projects)) return []
  return Object.entries(doc.projects)
    .filter(([, project]) => isPlainObject(project) && isPlainObject(project.mcpServers) && Object.hasOwn(project.mcpServers, name))
    .map(([projectPath]) => projectPath)
}

const normalizeProjectPath = (value, platform) => {
  const unified = value.replace(/\\/g, '/').replace(/\/+$/, '')
  return platform === 'win32' ? unified.toLowerCase() : unified
}

/**
 * Local-scope registrations in ~/.claude.json for one folder; they win over that folder's .mcp.json.
 * Read only: a missing or unreadable file means there is nothing to warn about.
 */
function findLocalRegistrations({ filePath, projectDir, name, platform = process.platform, fileSystem = fs }) {
  try {
    const file = readFile(fileSystem, filePath)
    if (!file) return []
    const doc = JSON.parse(stripBom(file.text))
    const target = normalizeProjectPath(projectDir, platform)
    return findShadowedProjects(isPlainObject(doc) ? doc : {}, name)
      .filter((projectPath) => normalizeProjectPath(projectPath, platform) === target)
  } catch {
    return []
  }
}

/** Write through a temp file; give up if someone else wrote the original meanwhile (Claude Code rewrites ~/.claude.json often). */
function writeSafely(fileSystem, filePath, originalText, nextText) {
  const tempPath = `${filePath}${TEMP_SUFFIX}`
  try {
    fileSystem.writeFileSync(tempPath, nextText, 'utf8')
    const current = readFile(fileSystem, filePath)
    if ((current ? current.text : null) !== originalText) {
      throw new SetupError(`${filePath} 을(를) 다른 프로그램이 방금 바꿨습니다. 다시 시도하세요.`)
    }
    fileSystem.renameSync(tempPath, filePath)
  } catch (err) {
    try { fileSystem.unlinkSync(tempPath) } catch { /* never created or already moved */ }
    if (err instanceof SetupError) throw err
    throw new SetupError(`${filePath} 에 쓰지 못했습니다: ${err.message}`)
  }
}

/**
 * Put `entry` under mcpServers[name].
 * @returns {{ result: 'added'|'replaced'|'unchanged'|'conflict', backupPath: string|null, shadowedProjects: string[], existingUrl?: string }}
 */
function applyServerEntry({ filePath, name, entry, overwrite = false, createIfMissing = false, fileSystem = fs }) {
  const original = readFile(fileSystem, filePath)
  if (original === null && !createIfMissing) {
    throw new SetupError(`${filePath} 이(가) 없습니다. Claude Code 를 한 번 실행한 뒤 다시 시도하세요.`)
  }
  const originalText = original ? original.text : null
  const doc = original ? parseDocument(original.text, filePath, createIfMissing) : {}
  const servers = doc.mcpServers || {}
  const shadowedProjects = findShadowedProjects(doc, name)
  const existing = Object.hasOwn(servers, name) ? servers[name] : undefined

  if (existing !== undefined && JSON.stringify(existing) === JSON.stringify(entry)) {
    return { result: 'unchanged', backupPath: null, shadowedProjects }
  }
  if (existing !== undefined && !overwrite) {
    // Only the url: the old headers may hold a token
    const existingUrl = isPlainObject(existing) && typeof existing.url === 'string' ? existing.url : ''
    return { result: 'conflict', existingUrl, backupPath: null, shadowedProjects }
  }

  const nextText = formatLike(originalText, { ...doc, mcpServers: { ...servers, [name]: entry } })
  let backupPath = null
  if (original) {
    backupPath = `${filePath}${BACKUP_SUFFIX}`
    try {
      fileSystem.writeFileSync(backupPath, original.bytes)
    } catch (err) {
      throw new SetupError(`백업 파일을 만들지 못해 수정하지 않았습니다: ${err.message}`)
    }
  }
  writeSafely(fileSystem, filePath, originalText, nextText)
  return { result: existing === undefined ? 'added' : 'replaced', backupPath, shadowedProjects }
}

module.exports = { buildServerEntry, applyServerEntry, findLocalRegistrations, SetupError, TOKEN_ENV_VAR }
