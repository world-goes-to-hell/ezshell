const fs = require('node:fs')
const path = require('node:path')
const { isDeepStrictEqual } = require('node:util')
const { TOKEN_ENV_VAR, readFile, stripBom, saveClientConfig } = require('./clientSetup.js')
const { jsonRegistration, tomlRegistration } = require('./clientConfigFormats.js')

const CLIENTS = ['claude', 'codex', 'gemini', 'opencode', 'cursor']
const absolute = value => typeof value === 'string' && path.isAbsolute(value) ? value : undefined

function openCodeFile({ project, home, env }) {
  const configDir = project ?? path.join(absolute(env.XDG_CONFIG_HOME) ?? path.join(home, '.config'), 'opencode')
  const filenames = ['opencode.jsonc', 'opencode.json']
  if (project) {
    const directories = [path.join(project, '.opencode'), project]
    const candidates = directories.flatMap(dir => filenames.map(file => path.join(dir, file)))
    return candidates.find(file => fs.existsSync(file)) ?? path.join(project, filenames[0])
  }
  if (absolute(env.OPENCODE_CONFIG)) return env.OPENCODE_CONFIG
  const candidates = [...filenames, 'config.json'].map(file => path.join(configDir, file))
  return candidates.find(file => fs.existsSync(file)) ?? candidates[0]
}

function resolveSetupTarget({ client, scope, projectDir }, home, env) {
  if (scope !== 'project' && scope !== 'global') throw new Error('설정 범위는 project 또는 global 이어야 합니다.')
  const project = scope === 'project' ? absolute(projectDir) : undefined
  if (scope === 'project' && (!project || !fs.statSync(project, { throwIfNoEntry: false })?.isDirectory())) {
    throw new Error('프로젝트 폴더를 찾을 수 없습니다.')
  }
  let filePath
  switch (client) {
    case 'claude':
      filePath = project ? path.join(project, '.mcp.json') : path.join(home, '.claude.json')
      break
    case 'codex':
      filePath = path.join(project ? path.join(project, '.codex') : absolute(env.CODEX_HOME) ?? path.join(home, '.codex'), 'config.toml')
      break
    case 'gemini':
      filePath = path.join(project ?? absolute(env.GEMINI_CLI_HOME) ?? home, '.gemini', 'settings.json')
      break
    case 'opencode':
      filePath = openCodeFile({ project, home, env })
      break
    case 'cursor':
      filePath = path.join(project ?? home, '.cursor', 'mcp.json')
      break
    default:
      throw new Error('지원하지 않는 MCP 클라이언트입니다.')
  }
  return { filePath, useEnvToken: Boolean(project), createIfMissing: client !== 'claude' || Boolean(project) }
}

function clientEntry(client, { url, token, useEnvToken }) {
  if (client === 'codex') {
    return useEnvToken ? { url, bearer_token_env_var: TOKEN_ENV_VAR } : { url, http_headers: { Authorization: `Bearer ${token}` } }
  }
  const variable = {
    gemini: '${' + TOKEN_ENV_VAR + '}',
    opencode: `{env:${TOKEN_ENV_VAR}}`,
    cursor: '${env:' + TOKEN_ENV_VAR + '}'
  }
  const headers = { Authorization: `Bearer ${useEnvToken ? variable[client] : token}` }
  if (client === 'gemini') return { httpUrl: url, headers }
  if (client === 'opencode') return { type: 'remote', url, oauth: false, headers }
  return { url, headers }
}

function applyClientRegistration({ client, filePath, name, entry, overwrite }) {
  const original = readFile(fs, filePath)
  const text = stripBom(original?.text ?? '')
  const { existing, edit } = client === 'codex' ? tomlRegistration(text, filePath, name) : jsonRegistration(text, filePath, client, name)
  if (isDeepStrictEqual(existing, entry)) return { result: 'unchanged', backupPath: null }
  if (existing !== undefined && !overwrite) {
    const url = existing?.url ?? existing?.httpUrl
    return { result: 'conflict', backupPath: null, existingUrl: typeof url === 'string' ? url : '' }
  }
  const nextText = (original?.text.startsWith('\uFEFF') ? '\uFEFF' : '') + edit(entry)
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  const backupPath = saveClientConfig(fs, filePath, original, nextText)
  return { result: existing === undefined ? 'added' : 'replaced', backupPath }
}

module.exports = { CLIENTS, resolveSetupTarget, clientEntry, applyClientRegistration }
