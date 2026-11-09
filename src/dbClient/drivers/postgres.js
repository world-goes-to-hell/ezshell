// PostgreSQL over a stream from the SSH connection (no port is opened on this PC).
// The session starts read-only with a statement time limit (startup options), and every query runs
// inside BEGIN READ ONLY ... ROLLBACK: a function that turned the session default off cannot make the
// next query writable, and whatever a query set is rolled back with it. Queries go through a cursor
// (the extended protocol allows one statement, and only the rows shown are fetched).
// Loaded by main.js at runtime (copied to out/main/src), so keep it CommonJS.
const { Client } = require('pg')
const Cursor = require('pg-cursor')
const { LIMITS, createCollector } = require('../results.js')

const MAX_OBJECTS = 5000
const BATCH_ROWS = 200

// Values stay as the server wrote them (dates without time zone shifts, big numbers exact);
// only booleans and small numbers become JS values
const NUMBER_TYPES = new Set([21, 23, 26, 700, 701])
const types = {
  getTypeParser(oid) {
    if (oid === 16) return (value) => value === 't'
    if (NUMBER_TYPES.has(oid)) return Number
    return (value) => value
  }
}

/** pg drives a net.Socket; an SSH channel is already connected and has no socket options. */
function asSocket(channel) {
  return Object.assign(channel, {
    setNoDelay() {},
    setKeepAlive() {},
    connect() { process.nextTick(() => channel.emit('connect')) }
  })
}

/** Ends the client and destroys its channel: end() alone waits forever on a tunnel that stopped answering. */
function discard(client) {
  client.end().catch(() => {})
  try { client.connection?.stream?.destroy() } catch { /* already gone */ }
}

async function connectOnce({ openStream, user, password, database, connectTimeoutMs, queryTimeoutMs }) {
  const channel = await openStream()
  const client = new Client({
    stream: asSocket(channel),
    user,
    password,
    database: database || undefined,
    application_name: 'ezShell',
    connectionTimeoutMillis: connectTimeoutMs,
    // Applied by the server at session start; a query cannot be sent before they hold
    options: `-c default_transaction_read_only=on -c statement_timeout=${queryTimeoutMs} -c idle_in_transaction_session_timeout=60000`,
    types
  })
  // A dropped tunnel must not reach the process as an unhandled 'error'
  client.on('error', () => {})
  try {
    await client.connect()
  } catch (err) {
    discard(client)
    throw err
  }
  return client
}

const readCursor = (cursor, count) => new Promise((resolve, reject) => {
  cursor.read(count, (err, rows, result) => (err ? reject(err) : resolve({ rows, result })))
})
const closeCursor = (cursor) => new Promise((resolve) => cursor.close(() => resolve()))

/**
 * A PostgreSQL session for one DB window. `openStream()` gives a new tunnel stream each time
 * (reconnecting, cancelling). One query at a time (connections.js).
 */
function createPostgresSession({ openStream, credentials, limits = {} }) {
  const { maxRows = LIMITS.maxRows, maxBytes = LIMITS.maxBytes, queryTimeoutMs = LIMITS.queryTimeoutMs, connectTimeoutMs = 15000 } = limits
  let client = null
  let info = null
  let database = credentials.database || ''
  // Where unqualified table names are looked up (search_path), for the tree and completion
  let defaultSchema = 'public'
  let isClosed = false
  // Which query is running, so a late cancel does not stop the next one
  let runningQuery = 0
  let querySeq = 0
  let isCancelling = false

  async function open() {
    const next = await connectOnce({ openStream, ...credentials, connectTimeoutMs, queryTimeoutMs })
    try {
      const { rows } = await next.query({ text: "SELECT version(), current_database(), current_setting('default_transaction_read_only'), current_schema()", rowMode: 'array' })
      // Never used unless the server took the read-only setting
      if (rows[0][2] !== 'on') throw Object.assign(new Error('read-only setting not applied'), { code: 'EZ_NOT_READ_ONLY' })
      info = { engine: 'postgres', product: 'PostgreSQL', version: String(rows[0][0]).split(' on ')[0].replace(/^PostgreSQL /, ''), missingGuards: [] }
      database = rows[0][1]
      defaultSchema = rows[0][3] || 'public'
    } catch (err) {
      discard(next)
      throw err
    }
    // The window closed while this was connecting
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
    if (!client) await open()
    return client
  }

  function drop() {
    const old = client
    client = null
    if (old) discard(old)
  }

  /** pg_cancel_backend from a second, short connection (allowed for the same role); one at a time. */
  async function cancel() {
    const target = client
    const queryId = runningQuery
    if (!target || !target.processID || queryId === 0 || isCancelling) return false
    isCancelling = true
    try {
      const helper = await connectOnce({ openStream, ...credentials, connectTimeoutMs, queryTimeoutMs })
      try {
        if (runningQuery !== queryId || client !== target) return false
        await helper.query('SELECT pg_cancel_backend($1)', [target.processID])
        return true
      } finally {
        discard(helper)
      }
    } finally {
      isCancelling = false
    }
  }

  async function query(sql) {
    const active = await ensure()
    const started = Date.now()
    const collector = createCollector({ maxRows, maxBytes })
    let timer = null
    const giveUp = new Promise((_, reject) => {
      // statement_timeout should end the query first; this covers a tunnel that stopped answering
      timer = setTimeout(() => {
        drop()
        reject(Object.assign(new Error('timeout'), { code: 'EZ_TIMEOUT' }))
      }, queryTimeoutMs + 5000)
    })
    giveUp.catch(() => {})
    runningQuery = ++querySeq
    let isInTransaction = false
    try {
      await Promise.race([active.query('BEGIN TRANSACTION READ ONLY'), giveUp])
      isInTransaction = true
      const cursor = active.query(new Cursor(sql, null, { rowMode: 'array', types }))
      let columns = []
      let command = null
      let affected = null
      for (;;) {
        const { rows, result } = await Promise.race([readCursor(cursor, BATCH_ROWS), giveUp])
        if (result?.fields?.length) columns = result.fields.map((f) => ({ name: f.name, type: String(f.dataTypeID) }))
        if (result?.command) command = result.command
        if (typeof result?.rowCount === 'number') affected = result.rowCount
        for (const row of rows) {
          if (!collector.add(row)) break
        }
        if (collector.isFull || rows.length < BATCH_ROWS) break
      }
      await Promise.race([closeCursor(cursor), giveUp])
      return {
        columns,
        rows: collector.rows,
        truncatedBy: collector.truncatedBy,
        affectedRows: columns.length === 0 && command ? affected : null,
        elapsedMs: Date.now() - started
      }
    } finally {
      runningQuery = 0
      clearTimeout(timer)
      // Also after an error: the transaction is then aborted and must be ended
      if (isInTransaction && client === active) {
        await active.query('ROLLBACK').catch(() => drop())
      }
    }
  }

  const rowsOf = async (text, values) => (await (await ensure()).query({ text, values, rowMode: 'array' })).rows

  async function listSchemas() {
    const rows = await rowsOf("SELECT nspname FROM pg_namespace WHERE nspname NOT LIKE 'pg\\_%' AND nspname <> 'information_schema' ORDER BY 1")
    return rows.map((r) => String(r[0]))
  }

  async function listTables(schema) {
    const rows = await rowsOf(
      `SELECT c.relname, c.relkind FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = $1 AND c.relkind IN ('r','p','v','m','f') ORDER BY 1 LIMIT ${MAX_OBJECTS}`, [schema])
    return rows.map((r) => ({ name: String(r[0]), kind: r[1] === 'v' || r[1] === 'm' ? 'view' : 'table' }))
  }

  async function listColumns(schema, table) {
    const rows = await rowsOf(
      `SELECT a.attname, format_type(a.atttypid, a.atttypmod), NOT a.attnotnull,
              EXISTS (SELECT 1 FROM pg_index i WHERE i.indrelid = c.oid AND i.indisprimary AND a.attnum = ANY(i.indkey))
       FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = $1 AND c.relname = $2 AND a.attnum > 0 AND NOT a.attisdropped ORDER BY a.attnum`, [schema, table])
    return rows.map((r) => ({ name: String(r[0]), type: String(r[1]), isNullable: r[2] === true, isKey: r[3] === true }))
  }

  return {
    open,
    query,
    cancel,
    listSchemas,
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

module.exports = { createPostgresSession }
