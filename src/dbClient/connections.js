// The open DB windows: one database session each, reached through the tab's SSH connection.
// A window is answered only about its own connection (ownerId = its webContents id), one request at
// a time, and every query passes the read-only check before it is sent.
// Loaded by main.js at runtime (copied to out/main/src), so keep it CommonJS.
const crypto = require('crypto')
const { checkReadOnly } = require('./sqlGuard.js')
const { DbError } = require('./messages.js')
const { SUPPORTED_ENGINES } = require('./discovery.js')
const { createMysqlSession } = require('./drivers/mysql.js')
const { createPostgresSession } = require('./drivers/postgres.js')

const MAX_WINDOWS = 10

const MESSAGES = {
  notFound: '이 DB 창의 접속 정보가 없습니다. 창을 닫고 다시 열어 주세요.',
  busy: '앞의 요청을 처리하는 중입니다. 끝난 뒤 다시 실행해 주세요.',
  tooMany: `DB 창은 ${MAX_WINDOWS}개까지 열 수 있습니다.`,
  badInput: '접속 정보가 올바르지 않습니다.',
  unsupported: '아직 지원하지 않는 DB 입니다. 지금은 MySQL·MariaDB·PostgreSQL 만 됩니다.'
}

const SESSION_FACTORIES = { mysql: createMysqlSession, postgres: createPostgresSession }

const isText = (value, max, { isRequired = false } = {}) =>
  typeof value === 'string' && value.length <= max && (!isRequired || value.trim().length > 0)

/** Checks what the renderer sent; returns clean copies or throws. */
function validateRequest({ endpoint, credentials } = {}) {
  if (!endpoint || !credentials) throw new DbError(MESSAGES.badInput)
  if (!SUPPORTED_ENGINES.has(endpoint.engine)) throw new DbError(MESSAGES.unsupported)
  const port = Number(endpoint.port)
  const host = typeof endpoint.host === 'string' ? endpoint.host.trim() : ''
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new DbError(MESSAGES.badInput)
  if (!host || host.length > 255 || /[\s/\\@]/.test(host)) throw new DbError(MESSAGES.badInput)
  if (!isText(credentials.user, 128, { isRequired: true }) || !isText(credentials.password ?? '', 1024) || !isText(credentials.database ?? '', 128)) {
    throw new DbError(MESSAGES.badInput)
  }
  return {
    endpoint: { engine: endpoint.engine, host, port },
    credentials: { user: credentials.user.trim(), password: credentials.password ?? '', database: (credentials.database ?? '').trim() }
  }
}

/**
 * `openStream(sessionId, host, port)` opens a channel to host:port from the tab's SSH server.
 * `createSession` is for tests.
 */
function createDbConnections({ openStream, createSession = (engine, options) => SESSION_FACTORIES[engine](options), limits = {} }) {
  const connections = new Map()
  // Opens still logging in count towards the window limit
  let pendingOpens = 0

  function own(ownerId, dbId) {
    const entry = connections.get(dbId)
    if (!entry || entry.ownerId !== ownerId) throw new DbError(MESSAGES.notFound)
    return entry
  }

  /** Runs `work` as the window's only request; others are refused until it ends. */
  async function exclusive(entry, work) {
    if (entry.isBusy) throw new DbError(MESSAGES.busy)
    entry.isBusy = true
    try {
      return await work()
    } finally {
      entry.isBusy = false
    }
  }

  /** Connects (so wrong passwords are told at once) and keeps the session for a window to attach to. */
  async function open({ sessionId, sessionName, ...request }) {
    if (connections.size + pendingOpens >= MAX_WINDOWS) throw new DbError(MESSAGES.tooMany)
    const { endpoint, credentials } = validateRequest(request)
    const session = createSession(endpoint.engine, {
      openStream: () => openStream(sessionId, endpoint.host, endpoint.port),
      credentials,
      limits
    })
    pendingOpens++
    let info
    try {
      info = await session.open()
    } finally {
      pendingOpens--
    }
    const dbId = crypto.randomUUID()
    connections.set(dbId, {
      dbId,
      sessionId,
      sessionName: typeof sessionName === 'string' ? sessionName.slice(0, 100) : '',
      endpoint,
      user: credentials.user,
      session,
      ownerId: null,
      isBusy: false
    })
    return { dbId, info }
  }

  function attach(dbId, ownerId) {
    const entry = connections.get(dbId)
    if (entry) entry.ownerId = ownerId
  }

  function describe(ownerId, dbId) {
    const { session, endpoint, sessionName, user } = own(ownerId, dbId)
    return { ...session.info, database: session.database, endpoint, sessionName, user }
  }

  function query(ownerId, dbId, sql) {
    const entry = own(ownerId, dbId)
    const check = checkReadOnly(sql, entry.endpoint.engine)
    if (!check.ok) throw new DbError(check.reason)
    return exclusive(entry, async () => ({ ...(await entry.session.query(sql)), database: entry.session.database }))
  }

  /** Asks the server to stop the running query; nothing to do when none runs. */
  async function cancel(ownerId, dbId) {
    const entry = own(ownerId, dbId)
    if (!entry.isBusy) return { cancelled: false }
    return { cancelled: await entry.session.cancel() }
  }

  const schemas = (ownerId, dbId) => {
    const entry = own(ownerId, dbId)
    return exclusive(entry, async () => ({ schemas: await entry.session.listSchemas(), current: entry.session.defaultSchema ?? entry.session.database }))
  }
  const tables = (ownerId, dbId, schema) => {
    const entry = own(ownerId, dbId)
    if (!isText(schema, 128, { isRequired: true })) throw new DbError(MESSAGES.badInput)
    return exclusive(entry, async () => ({ tables: await entry.session.listTables(schema) }))
  }
  const columns = (ownerId, dbId, schema, table) => {
    const entry = own(ownerId, dbId)
    if (!isText(schema, 128, { isRequired: true }) || !isText(table, 128, { isRequired: true })) throw new DbError(MESSAGES.badInput)
    return exclusive(entry, async () => ({ columns: await entry.session.listColumns(schema, table) }))
  }

  function close(dbId) {
    const entry = connections.get(dbId)
    if (!entry) return
    connections.delete(dbId)
    entry.session.close()
  }

  function closeAll() {
    for (const dbId of [...connections.keys()]) close(dbId)
  }

  return { open, attach, describe, query, cancel, schemas, tables, columns, close, closeAll, has: (dbId) => connections.has(dbId) }
}

module.exports = { createDbConnections, validateRequest, MESSAGES, MAX_WINDOWS }
