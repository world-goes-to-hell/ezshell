// MCP settings in userData/mcp.json. Kept apart from settings.json because the renderer
// rewrites that whole file; only the main process touches this one.
const fs = require('fs')
const crypto = require('crypto')

const DEFAULT_PORT = 47521
const MIN_PORT = 1024
const MAX_PORT = 65535
const ALERT_LEVELS = ['all', 'medium', 'danger']
const DEFAULT_ALERT_LEVEL = 'danger'
const TOKEN_PATTERN = /^[0-9a-f]{64}$/

const isValidPort = (value) => Number.isInteger(value) && value >= MIN_PORT && value <= MAX_PORT

const UPDATABLE = {
  enabled: (value) => typeof value === 'boolean' || 'enabled 는 true 또는 false 여야 합니다.',
  port: (value) => isValidPort(value) || `포트는 ${MIN_PORT}~${MAX_PORT} 사이의 정수여야 합니다.`,
  alertLevel: (value) => ALERT_LEVELS.includes(value) || '알림 수준은 all, medium, danger 중 하나여야 합니다.'
}

function createMcpConfigStore({ filePath, fileSystem = fs, randomBytes = crypto.randomBytes }) {
  const newToken = () => {
    const token = randomBytes(32).toString('hex')
    if (!TOKEN_PATTERN.test(token)) throw new Error('Generated token does not match pattern')
    return token
  }

  function read() {
    try {
      const parsed = JSON.parse(fileSystem.readFileSync(filePath, 'utf8'))
      return parsed && typeof parsed === 'object' ? parsed : {}
    } catch {
      return {}
    }
  }

  function save(config) {
    fileSystem.writeFileSync(filePath, JSON.stringify(config, null, 2), 'utf8')
  }

  function sanitize(raw) {
    return {
      enabled: raw.enabled === true,
      port: isValidPort(raw.port) ? raw.port : DEFAULT_PORT,
      alertLevel: ALERT_LEVELS.includes(raw.alertLevel) ? raw.alertLevel : DEFAULT_ALERT_LEVEL,
      token: typeof raw.token === 'string' && TOKEN_PATTERN.test(raw.token) ? raw.token : newToken()
    }
  }

  const stored = read()
  let current = sanitize(stored)
  if (JSON.stringify(current) !== JSON.stringify(stored)) save(current)

  function update(patch) {
    const changes = Object.entries(patch && typeof patch === 'object' ? patch : {})
    for (const [key, value] of changes) {
      if (!Object.hasOwn(UPDATABLE, key)) throw new Error(`바꿀 수 없는 설정입니다: ${key}`)
      const check = UPDATABLE[key]
      const verdict = check(value)
      if (verdict !== true) throw new Error(verdict)
    }
    const next = { ...current, ...Object.fromEntries(changes) }
    save(next)
    current = next
    return current
  }

  function regenerateToken() {
    const next = { ...current, token: newToken() }
    save(next)
    current = next
    return current
  }

  return { get: () => current, update, regenerateToken }
}

module.exports = { createMcpConfigStore, DEFAULT_PORT, ALERT_LEVELS }
