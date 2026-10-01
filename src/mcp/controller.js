// Wires the MCP pieces together for main.js: settings, server lifecycle, approvals, locking.
const fs = require('fs')
const os = require('os')
const path = require('path')
const { createMcpConfigStore } = require('./mcpConfig.js')
const { createAuditLog } = require('./auditLog.js')
const { createApprovalBroker } = require('./approval.js')
const { createSessionGateway } = require('./sessionGateway.js')
const { createToolHandlers } = require('./tools.js')
const { createActivityLog } = require('./activityLog.js')
const { createMcpHttpServer, MCP_PATH } = require('./server.js')
const { buildServerEntry, applyServerEntry, findLocalRegistrations, SetupError } = require('./clientSetup.js')
const { setTokenEnv: setTokenEnvDefault } = require('./tokenEnv.js')

const SERVER_NAME = 'my-ssh-client'

const serverUrl = (port) => `http://127.0.0.1:${port}${MCP_PATH}`

function buildRegisterCommand({ port, token }) {
  return `claude mcp add --transport http ${SERVER_NAME} ${serverUrl(port)} --header "Authorization: Bearer ${token}"`
}

const isDirectory = (dir) => {
  try { return fs.statSync(dir).isDirectory() } catch { return false }
}

/** Where the entry goes: a project's .mcp.json (token by variable) or Claude Code's user scope (token inline). */
function resolveSetupTarget({ scope, projectDir }, homeDir) {
  if (scope === 'global') return { filePath: path.join(homeDir, '.claude.json'), useEnvToken: false, createIfMissing: false }
  if (scope !== 'project') throw new Error('설정 범위는 project 또는 global 이어야 합니다.')
  if (typeof projectDir !== 'string' || !path.isAbsolute(projectDir) || !isDirectory(projectDir)) {
    throw new Error('프로젝트 폴더를 찾을 수 없습니다.')
  }
  return { filePath: path.join(projectDir, '.mcp.json'), useEnvToken: true, createIfMissing: true }
}

function describeStartError(err, port) {
  if (err && err.code === 'EADDRINUSE') return `포트 ${port} 이(가) 이미 사용 중입니다. 다른 포트를 지정하세요.`
  if (err && err.code === 'EACCES') return `포트 ${port} 을(를) 사용할 권한이 없습니다. 다른 포트를 지정하세요.`
  return `MCP 서버를 시작하지 못했습니다: ${err && err.message}`
}

function createMcpController({ userDataPath, version, isUnlocked, loadSessions, loadFolders, showApproval, dismissApproval, emitActivity, deps = {} }) {
  const configStore = deps.configStore || createMcpConfigStore({ filePath: path.join(userDataPath, 'mcp.json') })
  const audit = deps.audit || createAuditLog({ filePath: path.join(userDataPath, 'mcp-audit.log') })
  const approvals = deps.approvals || createApprovalBroker({ show: showApproval, dismiss: dismissApproval })
  const gateway = deps.gateway || createSessionGateway()
  const activity = deps.activity || createActivityLog({
    emit: (item) => {
      try { if (emitActivity) emitActivity(item) } catch { /* the window may be gone */ }
    }
  })
  const handlers = createToolHandlers({
    isUnlocked,
    getSessions: loadSessions,
    getFolders: loadFolders,
    getAlertLevel: () => configStore.get().alertLevel,
    approvals,
    gateway,
    audit,
    activity
  })
  const homeDir = deps.homeDir || os.homedir()
  const setTokenEnv = deps.setTokenEnv || setTokenEnvDefault
  const createServer = deps.createServer || createMcpHttpServer
  const server = createServer({ getConfig: () => configStore.get(), handlers, version })
  let lastError = null
  // Lifecycle changes run one at a time; a failed step must not break the chain.
  let chain = Promise.resolve()
  function enqueue(task) {
    const run = chain.then(task)
    chain = run.catch(() => {})
    return run
  }

  function getStatus() {
    const config = configStore.get()
    return { config, running: server.isRunning(), error: lastError, registerCommand: buildRegisterCommand(config) }
  }

  async function setupClient(request = {}) {
    const { scope } = request
    const target = resolveSetupTarget(request, homeDir)
    const { port, token } = configStore.get()
    const entry = buildServerEntry({ url: serverUrl(port), token, useEnvToken: target.useEnvToken })
    let outcome
    try {
      outcome = applyServerEntry({ ...target, name: SERVER_NAME, entry, overwrite: request.overwrite === true })
    } catch (err) {
      throw err instanceof SetupError ? new Error(err.message) : err
    }
    // A local-scope entry left by the copied `claude mcp add` command wins over the project's .mcp.json
    const shadowedProjects = scope === 'project'
      ? findLocalRegistrations({ filePath: path.join(homeDir, '.claude.json'), projectDir: request.projectDir, name: SERVER_NAME })
      : outcome.shadowedProjects
    const wantsEnv = target.useEnvToken && request.setTokenEnv === true && outcome.result !== 'conflict'
    const env = wantsEnv ? await setTokenEnv(token) : null
    return {
      scope,
      filePath: target.filePath,
      ...outcome,
      shadowedProjects,
      tokenEnv: env ? env.status : null,
      tokenEnvError: env && env.error ? env.error : null
    }
  }

  function disconnectAll() {
    approvals.cancelAll()
    gateway.closeAll()
  }

  async function sync() {
    const config = configStore.get()
    lastError = null
    if (server.isRunning() && (!config.enabled || server.port() !== config.port)) {
      await server.stop()
      disconnectAll()
    }
    if (config.enabled && !server.isRunning()) {
      try {
        await server.start()
      } catch (err) {
        lastError = describeStartError(err, config.port)
      }
    }
    return getStatus()
  }

  return {
    start: () => enqueue(sync),
    getStatus,
    updateConfig: (patch) => enqueue(async () => {
      configStore.update(patch)
      return sync()
    }),
    regenerateToken: () => enqueue(async () => {
      configStore.regenerateToken()
      return getStatus()
    }),
    setupClient,
    respondApproval: (id, approved) => approvals.respond(id, approved),
    readAudit: (limit) => audit.readRecent(limit),
    listActivity: () => activity.list(),
    cancelActivity: (id) => activity.cancel(id),
    onLocked: () => {
      disconnectAll()
      // Fresh start after unlock: home directories again, and nothing from before the lock on screen
      gateway.forgetCwds()
      activity.clear()
    },
    onSessionsSaved: () => gateway.closeAll(),
    shutdown: () => enqueue(async () => {
      disconnectAll()
      await server.stop()
    })
  }
}

module.exports = { createMcpController, buildRegisterCommand }
