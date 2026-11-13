// SQL Server over a stream from the SSH connection (no port is opened on this PC).
// SQL Server has no read-only session setting, so the protection is different from MySQL and
// PostgreSQL: every query runs inside a transaction that is always rolled back, and sqlGuard lets
// only one reading statement through (no INTO, no DML or EXEC words anywhere). `info.missingGuards`
// says so, and the window shows it. An account that may only read is still the real protection.
// Loaded by main.js at runtime (copied to out/main/src), so keep it CommonJS.
const Module = require('module')

/**
 * tedious loads the Azure sign-in libraries (@azure/*) as soon as it is loaded. Their current
 * versions need a newer Node than Electron 28 has and fail to load there, which stopped the whole
 * app from starting. Only SQL logins (user and password) are used here, so while tedious loads,
 * those libraries are answered with an empty stand-in. Nothing of them runs for a SQL login.
 */
function loadTedious() {
  const standIn = new Proxy(function () {}, {
    get: (target, key) => (key === '__esModule' ? false : key === 'prototype' ? target.prototype : standIn),
    apply: () => undefined,
    construct: () => ({})
  })
  const load = Module._load
  Module._load = function (request, ...rest) {
    return request.startsWith('@azure/') ? standIn : load.call(this, request, ...rest)
  }
  try {
    return require('tedious')
  } finally {
    Module._load = load
  }
}

const { Connection, Request, TYPES } = loadTedious()
const { LIMITS, createCollector } = require('../results.js')

const MAX_OBJECTS = 5000
const SYSTEM_DATABASES = new Set(['master', 'tempdb', 'model', 'msdb'])
const SYSTEM_SCHEMAS = new Set(['sys', 'information_schema', 'guest'])
const NO_SERVER_READ_ONLY = 'SQL Server 는 세션을 읽기 전용으로 둘 수 없습니다. 쿼리마다 트랜잭션으로 감싸 되돌리고, 조회 문장만 보냅니다. 조회 권한만 있는 계정을 쓰세요.'

/** [name]: the bracket form works whatever QUOTED_IDENTIFIER is */
const quote = (name) => `[${String(name).replace(/]/g, ']]')}]`

/** tedious expects a net.Socket; the SSH channel is a plain duplex stream */
function asSocket(channel) {
  for (const method of ['setKeepAlive', 'setNoDelay', 'setTimeout']) {
    if (typeof channel[method] !== 'function') channel[method] = () => channel
  }
  return channel
}

const pad = (n, width = 2) => String(n).padStart(width, '0')

/** Values as text the way SQL Server shows them; dates keep their wall-clock time (read as UTC) */
function plain(value, metadata) {
  if (value === null || value === undefined) return null
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'string') return value
  if (typeof value === 'bigint') return value.toString()
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) return null
    const type = metadata?.type?.name ?? ''
    const date = `${value.getUTCFullYear()}-${pad(value.getUTCMonth() + 1)}-${pad(value.getUTCDate())}`
    const millis = value.getUTCMilliseconds()
    const time = `${pad(value.getUTCHours())}:${pad(value.getUTCMinutes())}:${pad(value.getUTCSeconds())}${millis ? `.${pad(millis, 3)}` : ''}`
    if (type === 'Date') return date
    if (type === 'Time') return time
    return `${date} ${time}`
  }
  if (Buffer.isBuffer(value)) return `0x${value.subarray(0, 64).toString('hex')}${value.length > 64 ? '…' : ''}`
  return String(value)
}

function connectOnce({ openStream, user, password, database, connectTimeoutMs, queryTimeoutMs }) {
  return new Promise((resolve, reject) => {
    const connection = new Connection({
      // Only a name for the TLS handshake: the bytes go through the stream
      server: 'localhost',
      authentication: { type: 'default', options: { userName: user, password } },
      options: {
        connector: async () => asSocket(await openStream()),
        database: database || undefined,
        // The tunnel is already inside SSH; internal servers mostly have self-made certificates
        encrypt: true,
        trustServerCertificate: true,
        connectTimeout: connectTimeoutMs,
        requestTimeout: queryTimeoutMs,
        cancelTimeout: 5000,
        appName: 'ezShell',
        // An availability group sends such a connection to a readable secondary
        readOnlyIntent: true,
        useUTC: true,
        rowCollectionOnRequestCompletion: false
      }
    })
    connection.connect((err) => (err ? reject(err) : resolve(connection)))
  })
}

function discard(connection) {
  try {
    connection.close()
  } catch {
    // Already closed
  }
}

function createMssqlSession({ openStream, credentials, limits = {} }) {
  const { maxRows = LIMITS.maxRows, maxBytes = LIMITS.maxBytes, queryTimeoutMs = LIMITS.queryTimeoutMs, connectTimeoutMs = 15000 } = limits
  let client = null
  let info = null
  let database = credentials.database || ''
  let defaultSchema = 'dbo'
  let isClosed = false
  let isRunning = false

  /** One statement with named parameters; rows as arrays of plain values */
  function run(connection, sql, params = {}, onRow = null) {
    return new Promise((resolve, reject) => {
      let columns = []
      const rows = []
      const request = new Request(sql, (err, rowCount) => (err ? reject(err) : resolve({ columns, rows, rowCount })))
      for (const [name, value] of Object.entries(params)) request.addParameter(name, TYPES.NVarChar, value)
      request.on('columnMetadata', (meta) => {
        columns = meta.map((column) => ({ name: column.colName, type: String(column.type?.name ?? '').toLowerCase() }))
      })
      request.on('row', (cells) => {
        const row = cells.map((cell) => plain(cell.value, cell.metadata))
        if (onRow) onRow(row)
        else rows.push(row)
      })
      connection.execSql(request)
    })
  }

  const begin = (connection) => new Promise((resolve, reject) => connection.beginTransaction((err) => (err ? reject(err) : resolve())))
  const rollback = (connection) => new Promise((resolve) => connection.rollbackTransaction(() => resolve()))

  async function open() {
    const next = await connectOnce({ openStream, ...credentials, database, connectTimeoutMs, queryTimeoutMs })
    try {
      const { rows } = await run(next, "SELECT CAST(SERVERPROPERTY('ProductVersion') AS nvarchar(64)), DB_NAME(), SCHEMA_NAME()")
      info = { engine: 'mssql', product: 'SQL Server', version: String(rows[0][0]), missingGuards: [NO_SERVER_READ_ONLY] }
      database = String(rows[0][1])
      defaultSchema = rows[0][2] ? String(rows[0][2]) : 'dbo'
      // A query waiting for a lock gives up instead of holding the request
      await run(next, 'SET LOCK_TIMEOUT 5000')
    } catch (err) {
      discard(next)
      throw err
    }
    if (isClosed) {
      discard(next)
      throw Object.assign(new Error('closed'), { code: 'EZ_CLOSED' })
    }
    next.on('end', () => { if (client === next) client = null })
    next.on('error', () => { if (client === next) client = null })
    client = next
    return info
  }

  async function ensure() {
    if (client) return client
    await open()
    return client
  }

  function drop() {
    const old = client
    client = null
    if (old) discard(old)
  }

  /** Stops the running query (an attention signal on the same connection) */
  async function cancel() {
    if (!client || !isRunning) return false
    return client.cancel()
  }

  async function query(sql) {
    const active = await ensure()
    const started = Date.now()
    const collector = createCollector({ maxRows, maxBytes })
    let columns = []
    let wasStopped = false
    isRunning = true
    let isInTransaction = false
    try {
      await begin(active)
      isInTransaction = true
      const result = await run(active, sql, {}, (row) => {
        // Enough rows: tell the server to stop sending
        if (!collector.add(row) && !wasStopped) {
          wasStopped = true
          active.cancel()
        }
      }).catch((err) => {
        if (wasStopped && err?.code === 'ECANCEL') return null
        throw err
      })
      if (result) columns = result.columns
      return {
        columns: result ? result.columns : columns,
        rows: collector.rows,
        truncatedBy: collector.truncatedBy,
        affectedRows: null,
        elapsedMs: Date.now() - started
      }
    } finally {
      isRunning = false
      // Always: nothing a query did may stay
      if (isInTransaction && client === active) await rollback(active)
    }
  }

  /** Every database the account may use; the system ones are flagged (the tree hides them by default) */
  async function listDatabases() {
    const { rows } = await run(await ensure(), 'SELECT name FROM sys.databases WHERE state = 0 AND HAS_DBACCESS(name) = 1 ORDER BY name')
    return rows.map((r) => String(r[0])).map((name) => ({ name, isSystem: SYSTEM_DATABASES.has(name.toLowerCase()) }))
  }

  // One connection reads every database's catalog through three-part names; `db` comes from the
  // server's own list (connections.js checks) and is quoted
  async function listSchemas(db) {
    const { rows } = await run(await ensure(), `SELECT name FROM ${quote(db)}.sys.schemas ORDER BY name`)
    return rows.map((r) => String(r[0])).map((name) => ({ name, isSystem: SYSTEM_SCHEMAS.has(name.toLowerCase()) || name.toLowerCase().startsWith('db_') }))
  }

  async function useDatabase(name) {
    const active = await ensure()
    await run(active, `USE ${quote(name)}`)
    const { rows } = await run(active, 'SELECT DB_NAME(), SCHEMA_NAME()')
    database = String(rows[0][0])
    defaultSchema = rows[0][1] ? String(rows[0][1]) : 'dbo'
  }

  async function listTables(db, schema) {
    const { rows } = await run(await ensure(),
      `SELECT TOP ${MAX_OBJECTS} o.name, o.type FROM ${quote(db)}.sys.objects o JOIN ${quote(db)}.sys.schemas s ON s.schema_id = o.schema_id
       WHERE s.name = @schema AND o.type IN ('U', 'V') ORDER BY o.name`, { schema })
    return rows.map((r) => ({ name: String(r[0]), kind: String(r[1]).trim() === 'V' ? 'view' : 'table' }))
  }

  async function listColumns(db, schema, table) {
    const d = quote(db)
    const { rows } = await run(await ensure(),
      `SELECT c.name,
              t.name + CASE
                WHEN t.name IN ('varchar', 'char', 'varbinary', 'binary') THEN '(' + CASE WHEN c.max_length = -1 THEN 'max' ELSE CAST(c.max_length AS varchar(10)) END + ')'
                WHEN t.name IN ('nvarchar', 'nchar') THEN '(' + CASE WHEN c.max_length = -1 THEN 'max' ELSE CAST(c.max_length / 2 AS varchar(10)) END + ')'
                WHEN t.name IN ('decimal', 'numeric') THEN '(' + CAST(c.precision AS varchar(10)) + ',' + CAST(c.scale AS varchar(10)) + ')'
                ELSE '' END,
              c.is_nullable,
              CASE WHEN EXISTS (SELECT 1 FROM ${d}.sys.index_columns ic JOIN ${d}.sys.indexes i ON i.object_id = ic.object_id AND i.index_id = ic.index_id
                                WHERE i.is_primary_key = 1 AND ic.object_id = c.object_id AND ic.column_id = c.column_id) THEN 1 ELSE 0 END
       FROM ${d}.sys.columns c
       JOIN ${d}.sys.objects o ON o.object_id = c.object_id
       JOIN ${d}.sys.schemas s ON s.schema_id = o.schema_id
       JOIN ${d}.sys.types t ON t.user_type_id = c.user_type_id
       WHERE s.name = @schema AND o.name = @table ORDER BY c.column_id`, { schema, table })
    return rows.map((r) => ({ name: String(r[0]), type: String(r[1]), isNullable: r[2] === true, isKey: Number(r[3]) === 1 }))
  }

  return {
    open,
    query,
    cancel,
    listDatabases,
    listSchemas,
    useDatabase,
    listTables,
    listColumns,
    close() {
      isClosed = true
      drop()
    },
    get info() { return info },
    get database() { return database },
    get defaultSchema() { return defaultSchema },
    get isOpen() { return client !== null }
  }
}

module.exports = { createMssqlSession }
