// PostgreSQL over a stream from the SSH connection (no port is opened on this PC).
// The session starts read-only with a statement time limit (startup options), and every query runs
// inside BEGIN READ ONLY ... ROLLBACK: a function that turned the session default off cannot make the
// next query writable, and whatever a query set is rolled back with it. Queries go through a cursor
// (the extended protocol allows one statement, and only the rows shown are fetched).
// Loaded by main.js at runtime (copied to out/main/src), so keep it CommonJS.
const { Client } = require('pg')
const Cursor = require('pg-cursor')
const { LIMITS, createCollector } = require('../results.js')
const { buildPostgresDdl } = require('../ddl.js')

const MAX_OBJECTS = 5000
// DDL of a whole schema stops here (each table costs the server a few catalog reads)
const MAX_DDL_TABLES = 200
// Tables of one result whose foreign keys are looked up
const MAX_RELATION_TABLES = 16
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
  // server_version_num (150004 = 15.4): which catalog columns exist
  let serverVersion = 0
  let database = credentials.database || ''
  // Where unqualified table names are looked up (search_path), for the tree and completion
  let defaultSchema = 'public'
  // The schema the user chose to put first in search_path (null: the server's own search_path)
  let searchSchema = null
  let isClosed = false
  // Which query is running, so a late cancel does not stop the next one
  let runningQuery = 0
  let querySeq = 0
  let isCancelling = false

  async function open() {
    // `database` follows useDatabase; the first open uses the one typed in. Left empty, the server
    // would pick the database named like the user, which often does not exist (an admin account):
    // the maintenance database "postgres" is tried first, like DataGrip, then the user's own.
    let next
    if (database) {
      next = await connectOnce({ openStream, ...credentials, database, connectTimeoutMs, queryTimeoutMs })
    } else {
      try {
        next = await connectOnce({ openStream, ...credentials, database: 'postgres', connectTimeoutMs, queryTimeoutMs })
      } catch (err) {
        if (err?.code !== '3D000' && err?.code !== '42501') throw err
        next = await connectOnce({ openStream, ...credentials, database: credentials.user, connectTimeoutMs, queryTimeoutMs })
      }
    }
    try {
      const { rows } = await next.query({ text: "SELECT version(), current_database(), current_setting('default_transaction_read_only'), current_schema(), current_setting('server_version_num')", rowMode: 'array' })
      // Never used unless the server took the read-only setting
      if (rows[0][2] !== 'on') throw Object.assign(new Error('read-only setting not applied'), { code: 'EZ_NOT_READ_ONLY' })
      info = { engine: 'postgres', product: 'PostgreSQL', version: String(rows[0][0]).split(' on ')[0].replace(/^PostgreSQL /, ''), missingGuards: [] }
      database = rows[0][1]
      defaultSchema = rows[0][3] || 'public'
      serverVersion = Number(rows[0][4]) || 0
      await applySearchPath(next)
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
        // `source`: the table column a result column comes from (none for an expression), for foreign keys
        if (result?.fields?.length) columns = result.fields.map((f) => ({ name: f.name, type: String(f.dataTypeID), ...(f.tableID ? { source: { tableId: f.tableID, columnId: f.columnID } } : {}) }))
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

  /**
   * Catalog reads of `db`: the window's own connection for the current database, otherwise a short
   * connection to that database, closed as soon as the answer is in (PostgreSQL cannot read another
   * database's catalog, and connections kept open would stay on the server).
   */
  async function rowsIn(db, text, values) {
    if (!db || db === database) return (await (await ensure()).query({ text, values, rowMode: 'array' })).rows
    const helper = await connectOnce({ openStream, ...credentials, database: db, connectTimeoutMs, queryTimeoutMs })
    try {
      return (await helper.query({ text, values, rowMode: 'array' })).rows
    } finally {
      discard(helper)
    }
  }

  /** Databases the account may connect to (templates and closed ones left out) */
  async function listDatabases() {
    const rows = await rowsIn(null,
      "SELECT datname FROM pg_database WHERE datallowconn AND NOT datistemplate AND has_database_privilege(datname, 'CONNECT') ORDER BY 1")
    return rows.map((r) => ({ name: String(r[0]), isSystem: false }))
  }

  /** Schemas of `db`; the catalog ones are flagged (the tree hides them by default), toast/temp left out */
  async function listSchemas(db) {
    const rows = await rowsIn(db, "SELECT nspname FROM pg_namespace WHERE nspname !~ '^pg_(toast|temp_)' ORDER BY 1")
    return rows.map((r) => String(r[0])).map((name) => ({ name, isSystem: name === 'information_schema' || name.startsWith('pg_') }))
  }

  /** Queries run in one database: switching connects to the other one (read-only checked again) */
  /**
   * The chosen schema first in search_path, so `SELECT * FROM t` finds its tables; public stays after
   * it (extensions such as PostGIS live there). Set on the session outside the per-query read-only
   * transactions, so it lasts; set again after every reconnect (open).
   */
  async function applySearchPath(target) {
    if (!searchSchema) return
    const path = searchSchema === 'public' ? 'public' : `${target.escapeIdentifier(searchSchema)}, public`
    await target.query("SELECT set_config('search_path', $1, false)", [path])
    const { rows } = await target.query({ text: 'SELECT current_schema()', rowMode: 'array' })
    defaultSchema = rows[0][0] || 'public'
  }

  /** Unqualified names in this database go to `name` first (DataGrip: "기본 스키마") */
  async function useSchema(name) {
    const previous = searchSchema
    searchSchema = name
    try {
      await applySearchPath(await ensure())
    } catch (err) {
      searchSchema = previous
      throw err
    }
  }

  async function useDatabase(name) {
    const previous = database
    const previousSchema = searchSchema
    drop()
    database = name
    // A schema chosen for the old database means nothing in the new one
    searchSchema = null
    try {
      await open()
    } catch (err) {
      database = previous
      searchSchema = previousSchema
      await open().catch(() => {})
      throw err
    }
  }

  async function listTables(db, schema) {
    const rows = await rowsIn(db,
      `SELECT c.relname, c.relkind FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = $1 AND c.relkind IN ('r','p','v','m','f') ORDER BY 1 LIMIT ${MAX_OBJECTS}`, [schema])
    return rows.map((r) => ({ name: String(r[0]), kind: r[1] === 'v' || r[1] === 'm' ? 'view' : 'table' }))
  }

  async function listColumns(db, schema, table) {
    const rows = await rowsIn(db,
      `SELECT a.attname, format_type(a.atttypid, a.atttypmod), NOT a.attnotnull,
              EXISTS (SELECT 1 FROM pg_index i WHERE i.indrelid = c.oid AND i.indisprimary AND a.attnum = ANY(i.indkey))
       FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = $1 AND c.relname = $2 AND a.attnum > 0 AND NOT a.attisdropped ORDER BY a.attnum`, [schema, table])
    return rows.map((r) => ({ name: String(r[0]), type: String(r[1]), isNullable: r[2] === true, isKey: r[3] === true }))
  }

  /**
   * CREATE statements of one table, or of every table of a schema (at most MAX_DDL_TABLES), put
   * together from the catalog. Fixed catalog reads only; nothing the caller sends becomes SQL text.
   */
  async function ddl(db, schema, table) {
    const one = table ? ' AND c.relname = $2' : ''
    const values = table ? [schema, table] : [schema]
    const tableRows = await rowsIn(db,
      `SELECT c.relname, c.relkind, obj_description(c.oid, 'pg_class'),
              CASE WHEN c.relkind IN ('v','m') THEN pg_get_viewdef(c.oid, true) END
       FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = $1 AND c.relkind IN ('r','p','v','m','f')${one} ORDER BY 1 LIMIT ${MAX_DDL_TABLES + 1}`, values)
    const isCut = tableRows.length > MAX_DDL_TABLES
    const tables = tableRows.slice(0, MAX_DDL_TABLES).map((r) => ({ table: String(r[0]), kind: String(r[1]), comment: r[2] ?? null, viewDefinition: r[3] ?? null }))
    if (tables.length === 0) return { ddl: '', tableCount: 0, isCut: false }
    const names = tables.map((t) => t.table)
    const columnRows = await rowsIn(db,
      `SELECT c.relname, a.attname, format_type(a.atttypid, a.atttypmod), a.attnotnull, pg_get_expr(d.adbin, d.adrelid),
              ${serverVersion >= 100000 ? 'a.attidentity' : "''"}, col_description(c.oid, a.attnum)
       FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid JOIN pg_namespace n ON n.oid = c.relnamespace
       LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
       WHERE n.nspname = $1 AND c.relname = ANY($2::text[]) AND a.attnum > 0 AND NOT a.attisdropped
       ORDER BY c.relname, a.attnum`, [schema, names])
    const constraintRows = await rowsIn(db,
      `SELECT c.relname, con.conname, pg_get_constraintdef(con.oid)
       FROM pg_constraint con JOIN pg_class c ON c.oid = con.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = $1 AND c.relname = ANY($2::text[])
       ORDER BY c.relname, CASE con.contype WHEN 'p' THEN 0 WHEN 'u' THEN 1 WHEN 'f' THEN 2 ELSE 3 END, con.conname`, [schema, names])
    const indexRows = await rowsIn(db,
      `SELECT c.relname, pg_get_indexdef(i.indexrelid)
       FROM pg_index i JOIN pg_class c ON c.oid = i.indrelid JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = $1 AND c.relname = ANY($2::text[])
         AND NOT EXISTS (SELECT 1 FROM pg_constraint con WHERE con.conindid = i.indexrelid)
       ORDER BY c.relname, 2`, [schema, names])
    return {
      ddl: buildPostgresDdl(schema, {
        tables,
        columns: columnRows.map((r) => ({ table: String(r[0]), name: String(r[1]), type: String(r[2]), isNotNull: r[3] === true, defaultValue: r[4] ?? null, identity: String(r[5] ?? ''), comment: r[6] ?? null })),
        constraints: constraintRows.map((r) => ({ table: String(r[0]), name: String(r[1]), definition: String(r[2]) })),
        indexes: indexRows.map((r) => ({ table: String(r[0]), definition: String(r[1]) }))
      }),
      tableCount: tables.length,
      isCut
    }
  }

  /**
   * Foreign keys of result columns, in the current database. `sources` are the { tableId, columnId }
   * pairs `query` attached to the columns; the answer has one entry per source: `to` (what the
   * column refers to) and `from` (columns that refer to it). Single-column keys only: a value of
   * one column is what gets looked up.
   */
  async function relations(sources) {
    const tableIds = [...new Set(sources.map((s) => s.tableId))].slice(0, MAX_RELATION_TABLES)
    if (tableIds.length === 0) return sources.map(() => ({ to: [], from: [] }))
    const rows = await rowsIn(null,
      `SELECT con.conrelid::int8, con.conkey[1], n.nspname, c.relname, a.attname,
              con.confrelid::int8, con.confkey[1], fn.nspname, fc.relname, fa.attname
       FROM pg_constraint con
       JOIN pg_class c ON c.oid = con.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace
       JOIN pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = con.conkey[1]
       JOIN pg_class fc ON fc.oid = con.confrelid JOIN pg_namespace fn ON fn.oid = fc.relnamespace
       JOIN pg_attribute fa ON fa.attrelid = con.confrelid AND fa.attnum = con.confkey[1]
       WHERE con.contype = 'f' AND array_length(con.conkey, 1) = 1
         AND (con.conrelid = ANY($1::oid[]) OR con.confrelid = ANY($1::oid[]))
       ORDER BY 3, 4, 5 LIMIT 500`, [tableIds])
    return sources.map(({ tableId, columnId }) => ({
      to: rows.filter((r) => Number(r[0]) === tableId && Number(r[1]) === columnId).map((r) => ({ schema: String(r[7]), table: String(r[8]), column: String(r[9]) })),
      from: rows.filter((r) => Number(r[5]) === tableId && Number(r[6]) === columnId).map((r) => ({ schema: String(r[2]), table: String(r[3]), column: String(r[4]) }))
    }))
  }

  return {
    open,
    query,
    cancel,
    listDatabases,
    listSchemas,
    useDatabase,
    useSchema,
    listTables,
    listColumns,
    ddl,
    relations,
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
