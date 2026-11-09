// MySQL / MariaDB over a stream from the SSH connection (no port is opened on this PC).
// Every connection is made read-only by the server: SET SESSION TRANSACTION READ ONLY, autocommit,
// a statement time limit and sql_select_limit, so the server itself stops large or writing queries.
// Loaded by main.js at runtime (copied to out/main/src), so keep it CommonJS.
const mysql = require('mysql2')
const { LIMITS, createCollector } = require('../results.js')

const SYSTEM_SCHEMAS = ['mysql', 'information_schema', 'performance_schema', 'sys']
const MAX_OBJECTS = 5000

function connectOnce({ stream, user, password, database, connectTimeoutMs }) {
  return new Promise((resolve, reject) => {
    const conn = mysql.createConnection({
      stream,
      user,
      password,
      database: database || undefined,
      connectTimeout: connectTimeoutMs,
      dateStrings: true,
      supportBigNumbers: true,
      bigNumberStrings: true,
      multipleStatements: false,
      charset: 'utf8mb4_general_ci'
    })
    let isConnected = false
    // Kept for the connection's life: mysql2 emits 'error' on a dropped tunnel, and an unheard
    // 'error' event would end the main process
    conn.on('error', (err) => { if (!isConnected) reject(err) })
    conn.connect((err) => {
      if (err) {
        conn.destroy()
        return reject(err)
      }
      isConnected = true
      resolve(conn)
    })
  })
}

const run = (conn, sql, values) => new Promise((resolve, reject) => {
  conn.query({ sql, values, rowsAsArray: true }, (err, rows, fields) => (err ? reject(err) : resolve({ rows, fields })))
})

/** Server-side guards, tried one by one: old servers lack some of the variables. */
async function applySessionSettings(conn, { isMariaDb, maxRows, timeoutMs }) {
  // Without read-only the connection is not used at all
  await run(conn, 'SET SESSION TRANSACTION READ ONLY')
  await run(conn, 'SET autocommit = 1')
  const optional = [
    `SET SESSION sql_select_limit = ${maxRows + 1}`,
    isMariaDb
      ? `SET SESSION max_statement_time = ${Math.ceil(timeoutMs / 1000)}`
      : `SET SESSION MAX_EXECUTION_TIME = ${timeoutMs}`
  ]
  const missing = []
  for (const sql of optional) {
    try {
      await run(conn, sql)
    } catch {
      missing.push(sql)
    }
  }
  return missing
}

/**
 * A MySQL session for one DB window. `openStream()` gives a new tunnel stream each time
 * (reconnecting, cancelling). Not safe for two queries at once: connections.js runs one at a time.
 */
function createMysqlSession({ openStream, credentials, limits = {} }) {
  const { maxRows = LIMITS.maxRows, maxBytes = LIMITS.maxBytes, queryTimeoutMs = LIMITS.queryTimeoutMs, connectTimeoutMs = 15000 } = limits
  let conn = null
  let info = null
  let database = credentials.database || ''
  let isClosed = false
  // Which query is running, so a late cancel does not stop the next one
  let runningQuery = 0
  let querySeq = 0
  let isCancelling = false

  async function open(db = database) {
    const stream = await openStream()
    const next = await connectOnce({ stream, ...credentials, database: db, connectTimeoutMs })
    try {
      const { rows } = await run(next, 'SELECT VERSION(), DATABASE()')
      const version = String(rows[0][0])
      const isMariaDb = /mariadb/i.test(version)
      const missingGuards = await applySessionSettings(next, { isMariaDb, maxRows, timeoutMs: queryTimeoutMs })
      info = { engine: 'mysql', product: isMariaDb ? 'MariaDB' : 'MySQL', version, missingGuards }
      database = rows[0][1] || ''
    } catch (err) {
      next.destroy()
      throw err
    }
    // The window closed while this was connecting
    if (isClosed) {
      next.destroy()
      throw Object.assign(new Error('closed'), { code: 'EZ_CLOSED' })
    }
    next.on('error', () => { if (conn === next) conn = null })
    next.on('end', () => { if (conn === next) conn = null })
    conn = next
    return info
  }

  async function ensure() {
    if (!conn) await open()
    return conn
  }

  function drop() {
    const old = conn
    conn = null
    if (old) old.destroy()
  }

  /** KILL QUERY on a second, short connection (the first is busy sending the query); one at a time. */
  async function cancel() {
    const target = conn
    const queryId = runningQuery
    if (!target || queryId === 0 || isCancelling) return false
    isCancelling = true
    try {
      const stream = await openStream()
      const helper = await connectOnce({ stream, ...credentials, database: '', connectTimeoutMs })
      try {
        // The query may have ended while the helper connected; KILL QUERY would then hit the next one
        if (runningQuery !== queryId || conn !== target) return false
        await run(helper, `KILL QUERY ${Number(target.threadId)}`)
        return true
      } finally {
        helper.destroy()
      }
    } finally {
      isCancelling = false
    }
  }

  /**
   * Every query runs in its own START TRANSACTION READ ONLY ... ROLLBACK: even if a statement changed
   * the session's access mode (the app's check refuses SET, but the server must not depend on it),
   * the next query is read-only again.
   */
  async function query(sql) {
    const active = await ensure()
    await run(active, 'START TRANSACTION READ ONLY')
    try {
      return await streamQuery(active, sql)
    } finally {
      // A dropped connection (row limit, timeout) ends its transaction by itself
      if (conn === active) await run(active, 'ROLLBACK').catch(() => drop())
    }
  }

  function streamQuery(active, sql) {
    return new Promise((resolve, reject) => {
      const started = Date.now()
      const collector = createCollector({ maxRows, maxBytes })
      let columns = []
      let header = null
      let extraRows = 0
      let isSettled = false
      let giveUpTimer = null
      const queryId = ++querySeq
      runningQuery = queryId
      const settle = (fn, value) => {
        if (isSettled) return
        isSettled = true
        clearTimeout(timer)
        clearTimeout(giveUpTimer)
        if (runningQuery === queryId) runningQuery = 0
        fn(value)
      }
      // The server's own limit should stop the query first; this covers servers without it
      // and a tunnel that stopped answering. Cleared on settle, so it never drops a later query.
      const timer = setTimeout(() => {
        void cancel().catch(() => {})
        giveUpTimer = setTimeout(() => {
          if (conn === active) drop()
          settle(reject, Object.assign(new Error('timeout'), { code: 'EZ_TIMEOUT' }))
        }, 3000)
      }, queryTimeoutMs + 2000)

      const running = active.query({ sql, rowsAsArray: true })
      running.on('fields', (fields) => {
        columns = (fields || []).map((f) => ({ name: f.name, type: typeName(f) }))
      })
      running.on('result', (row) => {
        if (!Array.isArray(row)) {
          header = row
          return
        }
        if (collector.add(row)) return
        // sql_select_limit sends one row more than kept, so the first extra row is expected. A second
        // one means the query's own LIMIT is larger: stop reading, the connection is made again next time.
        extraRows++
        if (extraRows > 1) {
          active.pause()
          drop()
          settle(resolve, finish())
        }
      })
      running.on('error', (err) => settle(reject, err))
      running.on('end', () => settle(resolve, finish()))

      function finish() {
        if (/^\s*use\b/i.test(sql)) database = sql.trim().replace(/^use\s+/i, '').replace(/[`;]/g, '').trim()
        return {
          columns,
          rows: collector.rows,
          truncatedBy: collector.truncatedBy,
          affectedRows: header && typeof header.affectedRows === 'number' && columns.length === 0 ? header.affectedRows : null,
          elapsedMs: Date.now() - started
        }
      }
    })
  }

  /** Every database the account may see; system ones are flagged (the tree hides them by default) */
  async function listDatabases() {
    const active = await ensure()
    const { rows } = await run(active, 'SELECT SCHEMA_NAME FROM information_schema.SCHEMATA ORDER BY SCHEMA_NAME')
    return rows.map((r) => String(r[0])).map((name) => ({ name, isSystem: SYSTEM_SCHEMAS.includes(name.toLowerCase()) }))
  }

  /** In MySQL a database is a schema: one level, the database itself */
  async function listSchemas(db) {
    return [{ name: db, isSystem: SYSTEM_SCHEMAS.includes(String(db).toLowerCase()) }]
  }

  /** The current database for unqualified names (USE); the connection stays the same */
  async function useDatabase(name) {
    const active = await ensure()
    await run(active, 'USE ??', [name])
    database = name
  }

  // One connection reads every database's catalog, so `db` is only the schema name here
  async function listTables(db, schema = db) {
    const active = await ensure()
    // Only name columns: MySQL 5.7 then answers without opening every table
    const { rows } = await run(active,
      `SELECT TABLE_NAME, TABLE_TYPE FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? ORDER BY TABLE_NAME LIMIT ${MAX_OBJECTS}`,
      [schema])
    return rows.map((r) => ({ name: String(r[0]), kind: /view/i.test(String(r[1])) ? 'view' : 'table' }))
  }

  async function listColumns(db, schema, table) {
    const active = await ensure()
    const { rows } = await run(active,
      'SELECT COLUMN_NAME, COLUMN_TYPE, IS_NULLABLE, COLUMN_KEY FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? ORDER BY ORDINAL_POSITION',
      [schema, table])
    return rows.map((r) => ({ name: String(r[0]), type: String(r[1]), isNullable: r[2] === 'YES', isKey: r[3] === 'PRI' }))
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
    // In MySQL a schema is a database: unqualified names are looked up in the current one
    get defaultSchema() { return database },
    get isOpen() { return conn !== null }
  }
}

const TYPE_NAMES = { 0: 'decimal', 1: 'tinyint', 2: 'smallint', 3: 'int', 4: 'float', 5: 'double', 7: 'timestamp', 8: 'bigint', 9: 'mediumint', 10: 'date', 11: 'time', 12: 'datetime', 13: 'year', 15: 'varchar', 16: 'bit', 245: 'json', 246: 'decimal', 247: 'enum', 248: 'set', 249: 'blob', 250: 'blob', 251: 'blob', 252: 'blob', 253: 'varchar', 254: 'char', 255: 'geometry' }
function typeName(field) {
  return TYPE_NAMES[field.columnType] || String(field.columnType ?? '')
}

module.exports = { createMysqlSession }
