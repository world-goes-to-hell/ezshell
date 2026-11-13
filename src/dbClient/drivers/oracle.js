// Oracle through the tab's SSH connection. Its driver (node-oracledb, pure JavaScript "thin" mode)
// opens its own socket and cannot be handed a stream, so it connects to a port on 127.0.0.1 that
// exists only for the moment of connecting (../localTunnel.js).
// Reading only: every query runs in a transaction set READ ONLY (the server refuses INSERT, UPDATE,
// DELETE in it) that is rolled back afterwards, and sqlGuard lets only one SELECT through. DDL would
// end the transaction and a function declared autonomous can write: sqlGuard refuses those words,
// and `info.missingGuards` says the rest. An account that may only read is still the real protection.
// The thin mode needs Oracle Database 12.1 or later. With Oracle's own client libraries installed
// (../oracleClient.js) the driver runs in "thick" mode instead, which reaches 11.2 and later.
// Loaded by main.js at runtime (copied to out/main/src), so keep it CommonJS.
const path = require('path')
const { LIMITS, createCollector } = require('../results.js')
const { openOneShotTunnel } = require('../localTunnel.js')

// The library works in one of two modes, and a loaded copy of it cannot change its mode once it
// has tried to connect: "thin" (pure JavaScript, Oracle 12.1+) or "thick" (Oracle's own libraries,
// 11.2+). So each mode gets a copy of its own. Otherwise the libraries installed after a first
// attempt failed (which is how one finds out they are needed) would only work after a restart.
const copies = { thin: null, thick: null }

/** A copy of the library that shares nothing with the one loaded before */
function loadCopy() {
  const marker = `${path.sep}node_modules${path.sep}oracledb${path.sep}`
  for (const key of Object.keys(require.cache)) if (key.includes(marker)) delete require.cache[key]
  return require('oracledb')
}

/** The library for a connection: with Oracle's client libraries at `client` when they are installed */
function driverFor(client) {
  if (!client) {
    if (!copies.thin) copies.thin = copies.thick ? loadCopy() : require('oracledb')
    return copies.thin
  }
  if (!copies.thick) {
    const copy = copies.thin ? loadCopy() : require('oracledb')
    try {
      copy.initOracleClient({ libDir: client.libDir, configDir: client.configDir })
    } catch (err) {
      throw Object.assign(new Error(String(err && err.message).split(/\r?\n/)[0]), { code: 'EZ_ORACLE_CLIENT' })
    }
    copies.thick = copy
  }
  return copies.thick
}

/** The schemas Oracle itself owns, for versions that do not say so (before 12c) */
const SYSTEM_SCHEMAS = new Set(['SYS', 'SYSTEM', 'OUTLN', 'DBSNMP', 'XDB', 'CTXSYS', 'MDSYS', 'ORDSYS', 'ORDDATA', 'ORDPLUGINS', 'OLAPSYS', 'WMSYS', 'EXFSYS', 'APPQOSSYS', 'ANONYMOUS', 'XS$NULL', 'DIP', 'ORACLE_OCM', 'SI_INFORMTN_SCHEMA', 'FLOWS_FILES', 'MGMT_VIEW', 'SYSMAN', 'TSMSYS', 'OWBSYS', 'OWBSYS_AUDIT', 'SPATIAL_CSW_ADMIN_USR', 'SPATIAL_WFS_ADMIN_USR', 'APEX_PUBLIC_USER'])

const MAX_OBJECTS = 5000
const FETCH_ROWS = 200
/** A service name or SID as it goes into the connect string: nothing that could add to the string */
const SERVICE_NAME = /^[A-Za-z0-9_.$#-]{1,128}$/
const NOT_FULLY_READ_ONLY = 'Oracle 은 쿼리마다 읽기 전용 트랜잭션으로 감싸 되돌리고, 조회 문장만 보냅니다. 다만 스스로 커밋하는 함수(자율 트랜잭션)까지는 막지 못하므로 조회 권한만 있는 계정을 쓰세요.'
// Numbers written with a point whatever the account's language is
const SESSION_FORMATS = "ALTER SESSION SET NLS_NUMERIC_CHARACTERS = '.,'"

/** "NAME": upper-case names stay as they are, and a name with other characters still works */
const quote = (name) => `"${String(name).replace(/"/g, '""')}"`

const pad = (n, width = 2) => String(n).padStart(width, '0')

/** A number as Oracle wrote it: a JS number when that loses nothing, the text otherwise */
function plainNumber(text) {
  const normal = text.replace(/^(-?)\./, '$10.')
  const number = Number(normal)
  return Number.isFinite(number) && String(number) === normal ? number : normal
}

/** How values are fetched and written, for one copy of the library (its type constants are its own) */
function helpersFor(oracledb) {
/** Numbers come as text (no lost digits) and long text as text; dates stay dates and are written here */
function fetchTypeHandler(meta) {
  const type = meta.dbType
  if (type === oracledb.DB_TYPE_NUMBER || type === oracledb.DB_TYPE_CLOB || type === oracledb.DB_TYPE_NCLOB) return { type: oracledb.STRING }
  return undefined
}

/**
 * A date as the database shows it. The driver gives DATE and TIMESTAMP as a JavaScript date whose
 * local time is the stored time, so the local parts are written (a DATE has no fraction).
 */
function plainDate(value, meta) {
  if (Number.isNaN(value.getTime())) return null
  const date = `${pad(value.getFullYear(), 4)}-${pad(value.getMonth() + 1)}-${pad(value.getDate())}`
  const time = `${pad(value.getHours())}:${pad(value.getMinutes())}:${pad(value.getSeconds())}`
  const millis = value.getMilliseconds()
  const isDateOnlyType = meta && meta.dbType === oracledb.DB_TYPE_DATE
  return `${date} ${time}${!isDateOnlyType && millis ? `.${pad(millis, 3)}` : ''}`
}

function plain(value, meta) {
  if (value === null || value === undefined) return null
  if (typeof value === 'string') return meta && meta.dbType === oracledb.DB_TYPE_NUMBER ? plainNumber(value) : value
  if (typeof value === 'number' || typeof value === 'boolean') return value
  if (typeof value === 'bigint') return value.toString()
  if (Buffer.isBuffer(value)) return `0x${value.subarray(0, 64).toString('hex')}${value.length > 64 ? '…' : ''}`
  if (value instanceof Date) return plainDate(value, meta)
  // A binary large object is not read (it can be gigabytes)
  if (typeof value.destroy === 'function') {
    value.destroy()
    return '(BLOB)'
  }
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}
  return { fetchTypeHandler, plain }
}

/** Oracle's messages end with a line "Help: https://docs.oracle.com/..."; the screen shows the message alone */
function withoutHelp(err) {
  if (err && typeof err.message === 'string') err.message = err.message.split(/\r?\nHelp:/)[0].trim()
  return err
}

const isUnknownService = (err) => /ORA-12514|ORA-12505|NJS-518|NJS-515/.test(String(err && err.message))

function discard(connection) {
  // close() waits for the server; a connection that is gone must not hold anything up
  Promise.resolve().then(() => connection.close()).catch(() => {})
}

function createOracleSession({ openStream, credentials, limits = {}, oracleClient = () => null }) {
  const { maxRows = LIMITS.maxRows, maxBytes = LIMITS.maxBytes, queryTimeoutMs = LIMITS.queryTimeoutMs, connectTimeoutMs = 15000 } = limits
  const service = String(credentials.database || '').trim()
  let client = null
  let tunnel = null
  let info = null
  let defaultSchema = ''
  let isClosed = false
  let isRunning = false
  // The copy of the library this window uses (chosen at its first connection) and its helpers
  let oracledb = null
  let helpers = null

  /** One attempt: a port for this connection only, then the driver connects through it */
  async function connectWith(describe) {
    const opened = await openOneShotTunnel({ openStream, waitMs: connectTimeoutMs })
    try {
      const connection = await oracledb.getConnection({
        user: credentials.user,
        password: credentials.password,
        connectString: describe(opened.port),
        connectTimeout: Math.ceil(connectTimeoutMs / 1000)
      })
      return { connection, opened }
    } catch (err) {
      opened.close()
      throw err
    }
  }

  async function connectOnce() {
    if (!SERVICE_NAME.test(service)) throw Object.assign(new Error('Oracle 은 서비스 이름(또는 SID)이 필요합니다. 예: ORCL, XEPDB1'), { code: 'EZ_INPUT' })
    if (!oracledb) {
      oracledb = driverFor(oracleClient())
      helpers = helpersFor(oracledb)
    }
    try {
      return await connectWith((port) => `127.0.0.1:${port}/${service}`)
    } catch (err) {
      // An old server and the pure-JavaScript mode: Oracle's libraries are needed (messages.js says so)
      if (!isUnknownService(err)) throw err
      // Not a service name the listener knows: older setups are reached by their SID
      return connectWith((port) => `(DESCRIPTION=(ADDRESS=(PROTOCOL=TCP)(HOST=127.0.0.1)(PORT=${port}))(CONNECT_DATA=(SID=${service})))`)
    }
  }

  const options = () => ({ outFormat: oracledb.OUT_FORMAT_ARRAY, fetchTypeHandler: helpers.fetchTypeHandler })

  /** One statement with named binds; rows as arrays of plain values */
  async function run(connection, sql, binds = {}) {
    const result = await connection.execute(sql, binds, { ...options(), maxRows: MAX_OBJECTS })
    const meta = result.metaData || []
    return (result.rows || []).map((row) => row.map((value, i) => helpers.plain(value, meta[i])))
  }

  async function open() {
    const { connection, opened } = await connectOnce().catch((err) => { throw withoutHelp(err) })
    try {
      connection.callTimeout = queryTimeoutMs
      await connection.execute(SESSION_FORMATS)
      const rows = await run(connection, "SELECT SYS_CONTEXT('USERENV', 'CURRENT_SCHEMA') FROM dual")
      defaultSchema = String(rows[0][0])
      info = { engine: 'oracle', product: 'Oracle', version: String(connection.oracleServerVersionString || ''), missingGuards: [NOT_FULLY_READ_ONLY] }
    } catch (err) {
      discard(connection)
      opened.close()
      throw err
    }
    if (isClosed) {
      discard(connection)
      opened.close()
      throw Object.assign(new Error('closed'), { code: 'EZ_CLOSED' })
    }
    client = connection
    tunnel = opened
    return info
  }

  async function ensure() {
    if (client) return client
    await open()
    return client
  }

  function drop() {
    const old = client
    const oldTunnel = tunnel
    client = null
    tunnel = null
    if (old) discard(old)
    // After the driver had its chance to say goodbye
    if (oldTunnel) setTimeout(() => oldTunnel.close(), 500).unref?.()
  }

  /** Stops the running query (a break sent on the same connection) */
  async function cancel() {
    if (!client || !isRunning) return false
    await client.breakExecution()
    return true
  }

  async function query(sql) {
    const active = await ensure()
    const started = Date.now()
    const collector = createCollector({ maxRows, maxBytes })
    let columns = []
    isRunning = true
    try {
      // The server refuses INSERT, UPDATE and DELETE until the transaction ends
      await active.execute('SET TRANSACTION READ ONLY')
      // One statement, without the semicolon the console ends it with
      const result = await active.execute(sql.replace(/;\s*$/, ''), [], { ...options(), resultSet: true, fetchArraySize: FETCH_ROWS })
      const meta = result.metaData || []
      columns = meta.map((column) => ({ name: column.name, type: String(column.dbTypeName || '').toLowerCase() }))
      const cursor = result.resultSet
      if (cursor) {
        try {
          let isFull = false
          while (!isFull) {
            const rows = await cursor.getRows(FETCH_ROWS)
            if (rows.length === 0) break
            for (const row of rows) {
              if (!collector.add(row.map((value, i) => helpers.plain(value, meta[i])))) {
                isFull = true
                break
              }
            }
          }
        } finally {
          await cursor.close().catch(() => {})
        }
      }
      return { columns, rows: collector.rows, truncatedBy: collector.truncatedBy, affectedRows: null, elapsedMs: Date.now() - started }
    } catch (err) {
      // The connection is not usable after a timeout or a break that the server did not answer
      if (/NJS-(040|123|500|501|503|510|511)|DPI-(1010|1067|1080)/.test(String(err && err.message))) drop()
      throw withoutHelp(err)
    } finally {
      isRunning = false
      // Always: nothing a query did may stay
      if (client === active) await active.rollback().catch(() => drop())
    }
  }

  /** One connection reaches one service: that is the "database" of this window */
  async function listDatabases() {
    await ensure()
    return [{ name: service, isSystem: false }]
  }

  async function useDatabase(name) {
    if (name !== service) throw Object.assign(new Error('Oracle 은 접속한 서비스 안에서만 조회합니다. 다른 서비스는 계정 창에서 따로 접속하세요.'), { code: 'EZ_INPUT' })
  }

  async function listSchemas() {
    const active = await ensure()
    // Before 12c the server does not say which schemas are its own
    if (Number(String(info && info.version).split('.')[0]) < 12) {
      const rows = await run(active, 'SELECT username FROM all_users ORDER BY username')
      return rows.map((r) => String(r[0])).map((name) => ({ name, isSystem: SYSTEM_SCHEMAS.has(name) || /^(APEX|FLOWS)_\d+$/.test(name) }))
    }
    const rows = await run(active, 'SELECT username, oracle_maintained FROM all_users ORDER BY username')
    return rows.map((r) => ({ name: String(r[0]), isSystem: r[1] === 'Y' }))
  }

  /** The schema names without an owner are looked up in (the session's current schema) */
  async function useSchema(schema) {
    const active = await ensure()
    await active.execute(`ALTER SESSION SET CURRENT_SCHEMA = ${quote(schema)}`)
    defaultSchema = schema
  }

  async function listTables(db, schema) {
    const rows = await run(await ensure(),
      `SELECT name, kind FROM (
         SELECT table_name AS name, 'table' AS kind FROM all_tables WHERE owner = :owner AND nested = 'NO'
         UNION ALL
         SELECT view_name, 'view' FROM all_views WHERE owner = :owner
       ) WHERE ROWNUM <= ${MAX_OBJECTS} ORDER BY name`, { owner: schema })
    return rows.map((r) => ({ name: String(r[0]), kind: r[1] === 'view' ? 'view' : 'table' }))
  }

  // One table at a time: the dictionary views are slow when read for a whole schema
  async function listColumns(db, schema, table) {
    const rows = await run(await ensure(),
      `SELECT c.column_name, c.data_type, c.data_precision, c.data_scale, c.char_length, c.nullable,
              (SELECT COUNT(*) FROM all_constraints k JOIN all_cons_columns kc ON kc.owner = k.owner AND kc.constraint_name = k.constraint_name
                WHERE k.constraint_type = 'P' AND k.owner = c.owner AND k.table_name = c.table_name AND kc.column_name = c.column_name)
       FROM all_tab_columns c WHERE c.owner = :owner AND c.table_name = :name ORDER BY c.column_id`, { owner: schema, name: table })
    return rows.map((r) => {
      const [name, type, precision, scale, length, nullable, keys] = r
      const size = /CHAR/.test(String(type)) && length ? `(${length})`
        : type === 'NUMBER' && precision !== null ? `(${precision}${scale ? `,${scale}` : ''})` : ''
      return { name: String(name), type: `${String(type).toLowerCase()}${size}`, isNullable: nullable === 'Y', isKey: Number(keys) > 0 }
    })
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
    close() {
      isClosed = true
      drop()
    },
    get info() { return info },
    get database() { return service },
    get defaultSchema() { return defaultSchema },
    get isOpen() { return client !== null }
  }
}

module.exports = {
  createOracleSession,
  SERVICE_NAME,
  plainNumber,
  /** Whether Oracle's client libraries were loaded in this run (their files are then in use) */
  isThickLoaded: () => copies.thick !== null
}
